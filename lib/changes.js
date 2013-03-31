/*
 * couchdb.js: Plugin for adding and removing Domains from the balancer based on a CouchDB changes feed.
 *
 * (C) 2011, Nodejitsu Inc.
 *
 */

var events = require('events'),
    util = require('util'),
    async = require('async'),
    qs = require('qs'),
    request = require('request');

//
// ### function Changes (options)
// #### @options {Object} Options for this changes feed.
// ####   @options.timeout      {Object} Retry options on error.
// ####   @options.timeout.max  {number} Maximum timeout to wait between retries.
// ####   @options.timeout.step {number} Step interval for timeout between retries.
// ####   @options.views        {Object} Metadata about any views to be queried.
// ####   @options.url          {string} Fully qualified CouchDB URL (including auth).
// ####   @options.updateSeq    {number} update_seq to start changes from.
// Constructor function for the Changes object that is responsible for
// creating and maintaining a persisent `_changes` connection with CouchDB
// and optionally querying any views.
//
var Changes = module.exports = function (options) {
  events.EventEmitter.call(this, options);

  this.timeout      = options.timeout   || {};
  this.timeout.max  = this.timeout.max  || 30000;
  this.timeout.step = this.timeout.step || 2000;
  this.views        = options.views;
  this.url          = options.url;
  this.updateSeq    = options.updateSeq || 0;
  this.retry        = {
    enabled:  true,
    timeout:  0,
    attempts: 0,
  }
};

//
// Inherit from `events.EventEmitter`.
//
util.inherits(Changes, events.EventEmitter);

//
// ### function listen (updateSeq, callback)
// #### @updateSeq {number} **Optional** update_seq to start changes from.
// #### @callback {function} Continuation to respond once connected.
// Starts listening to the `_changes` feed at the optional `updateSeq`.
// Responds to the optional `callback` once a response from CouchDB is
// received.
//
Changes.prototype.listen = function (updateSeq, callback) {
  if (!callback && typeof updateSeq === 'function') {
    callback  = updateSeq;
    updateSeq = null;
  }

  updateSeq = updateSeq || this.updateSeq;

  //
  // Start the changes listener at `updateSeq` or the
  // first update.
  //
  var feedUrl = this.url + '/_changes?feed=continuous&include_docs=true&since=' + (updateSeq || 0),
      changes = request({ url: feedUrl }),
      self    = this,
      line    = '',
      responded;

  //
  // Respond to an optional callback
  //
  function respond(err) {
    if (!responded) {
      responded = true;
      if (callback) {
        callback(err);
      }
    }
  }

  changes.on('response', function (res) {
    respond();

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

  //
  // If the changes end, attempt to parse
  // the last data received and then restart
  // the connection
  //
  changes.on('end', function () {
    if (line.length !== 0) {
      try {
        var row = JSON.parse(line);
        self.emit('change', row);
      }
      catch (e) {
        //
        // ignore this line, it will be removed at end
        //
      }
    }

    // Restart the connection.
    self.listen(updateSeq);
  });

  //
  // There are two important cases for errors:
  // 1. _First attempt errors:_ This may indicate that CouchDB
  //    isn't running at the location provided. In that case
  //    attempt to respond to the optional callback with the error.
  // 2. _Connection drops:_ This is most likely a hiccup in CouchDB
  //    so simply emit an error.
  //
  changes.on('error', function (err) {
    if (!responded) {
      respond(err);
    }
    else {
      self.emit('error:changes', err);
    }

    //
    // Retry with incremental backoff.
    // Limit retry timeout to value of `this.timeout.max` config value.
    //
    var retryTimeout = self.retry.timeout,
        maxTimeout   = self.timeout.max,
        step         = self.timeout.step;

    //
    // Only attempt to retry if it is enabled. Since we respond
    // to the callback or emit the error event before this block
    // the caller has an opportunity to disable retrying.
    //
    if (self.retry.enabled) {
      self.retry.attempts++;

      setTimeout(function () {
        self.listen(updateSeq);
      }, retryTimeout);

      if (!maxTimeout || (retryTimeout + step) < maxTimeout) {
        self.retry.timeout += step;
      }
      else if (maxTimeout) {
        self.retry.timeout = maxTimeout;
      }
    }
  });
};

//
// ### function queryAndListen (callback)
// #### @callback {function} Continuation to respond to on _changes.
// Attempts to query all of `this.views`.
//
Changes.prototype.query = function (callback) {
  var views = Object.keys(this.views),
      url   = this.url,
      self  = this,
      updateSeq;

  if (!views.length) {
    return callback();
  }

  async.forEach(
    views,
    function queryOne(view, next) {
      var path  = self.views[view].path,
          query = self.views[view].query || {};

      query['update_seq'] = true;

      request({
        url: self.url + '/' + path + '?' + qs.stringify(query)
      }, function (err, res, body) {
        if (err) {
          //
          // Free up potentially large objects
          //
          body = null;
          res  = null;
          return next(err);
        }

        var json;
        try { json = JSON.parse(body) }
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

        //
        // Emit the rows found when querying the view.
        //
        self.emit(['views', view].join(':'), json.rows);

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
      if (err) {
        return !callback
          ? self.emit('error:views', err)
          : callback(err);
      }

      self.updateSeq = updateSeq;
      self.emit('views');
      callback(null, updateSeq);
    }
  );
};

//
// ### function queryAndListen (callback)
// #### @callback {function} Continuation to respond to on _changes.
// Attempts to query all of `this.views` and then establish a connection
// to the CouchDB `_changes` feed. If `this.views` is set then this
// instance will emit `views:<name>` events for each document received.
//
Changes.prototype.queryAndListen = function (callback) {
  var self = this;
  this.query(function (err, updateSeq) {
    if (err) {
      return !callback
        ? self.emit('error:views', err)
        : callback(err);
    }

    self.listen(updateSeq, callback);
  });
};