/*
 * couchdb.js: Plugin for adding and removing Domains from the balancer based on a CouchDB changes feed.
 *
 * (C) 2011, Nodejitsu Inc.
 *
 */

var events = require('events'),
    request = require('request'),
    utile = require('utile'),
    async = utile.async;

var Changes = module.exports = function (options) {
  events.EventEmitter.call(this, options);

  this.retry        = options.retry;
  this.views        = options.views;
  this.url          = options.url;
  this.retryTimeout = 0;
  this.updateSeq    = 0;
};

utile.inherits(Changes, events.EventEmitter);

Changes.prototype.listen = function (updateSeq) {
  if (!updateSeq) {
    updateSeq = this.updateSeq;
  }
  
  var self    = this,
      url     = this.url,
      feedUrl = couchUrl + '/_changes?feed=continuous&include_docs=true&since=' + (updateSeq || 0),
      changes = request({ url: feedUrl }),
      line    = '';

  changes.on('response', function (res) {
    changes.on('data', function (data) {
      line += data;
      var parts = line.split('\n');
      for (var i = 0; i < parts.length - 1; i++) {
        var piece = parts[i],
            row;

        if (piece.length === 0) continue;
        try {
          row = JSON.parse(piece);
          if (!row) return;
          updateSeq = row.last_seq || row.seq;
        }
        catch (e) {
          // ignore this line, it will be removed at end
        }

        self.emit('change', row);
      }
      line = parts[parts.length - 1];
    });
  });

  changes.on('end', function () {
    if (line.length !== 0) {
      var row;
      try {
        row = JSON.parse(line);
      }
      catch (e) {
        //
        // ignore this line, it will be removed at end
        //
      }
      self.emit('change', row);
    }
    //
    // Reconnect
    //
    self.listen(updateSeq);
  });

  changes.on('error', function (err) {
    self.emit('error', err);

    //
    // Retry with incremental backoff.
    // Limit retry timeout to value of `this.retry.max` config value.
    //
    var retryTimeout = self.retryTimeout,
        maxTimeout   = self.retry.max,
        step         = self.retry.step;

    setTimeout(function () {
      self.listen(updateSeq);
    }, retryTimeout);

    if (!maxTimeout || (retryTimeout + step) < maxTimeout) {
      self.retryTimeout += step;
    }
    else if (maxTimeout) {
      self.retryTimeout = maxTimeout;
    }
  });
};

Changes.prototype.queryAndListen = function () {
  var views = Object.keys(this.views),
      url   = this.url,
      self  = this,
      updateSeq;
  
  if (!views.length) {
    return this.listen();
  }
  
  async.forEach(
    views,
    function queryOne(view, next) {
      var path  = self.views[view].path,
          query = self.views[view].query || {};
      
      query['update_seq'] = true;
      
      request({
        url: self.url + '/' path + '?' + qs.stringify(query)
      }, function (err, res, body) {
        if (err) {
          //
          // Free up potentially large objects
          //
          body = null;
          res  = null;
          return next(err);
        }

        try { body = JSON.parse(body) }
        catch (ex) {
          //
          // Free up potentially large objects
          //
          err  = null;
          res  = null;
          body = null;
          return next(ex);
        }
        
        //
        // Set the updateSeq. The last query returned
        // will win the race and ensure the latest value.
        //
        updateSeq = body.update_seq || updateSeq || 0;
        
        var event = ['doc', view].join(':');
        body.rows && body.rows.forEach(function (row) {
          self.emit(event, row);
        });
        
        //
        // Free up potentially large objects
        //
        err  = null;
        res  = null;
        body = null;
        next();
      });
    },
    function (err) {
      return err
        ? self.emit('error', err)
        : self.listen(updateSeq);
    }
  );
};