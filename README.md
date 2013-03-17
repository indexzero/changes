# changes

A consistent, fault tolerant CouchDB _changes listener with pre-fetch support.

## Usage

``` js
  var Changes = require('changes');
  
  var changes = new Changes({
    url: 'http://user:pass@127.0.0.1:5984/database',
    timeout: {
      max:  60000,
      step: 5000
    }
  });
  
  //
  // Dump changes as they come in.
  //
  changes.on('change', function (doc) {
    console.dir(doc);
  });
  
  //
  // The callback will be called once a _changes
  // connection has been established or with an
  // error if the first connection fails.
  //
  changes.listen(function (err) {
    if (err) {
      console.log('Did not connect to _changes on first attempt');
      console.dir(err);
      changes.retry.enabled = false;
      return process.exit(1);
    }
    
    console.log('Listening for _changes');
  });
```

## Pre-fetching Views

Often when you establish a connection to `_changes` you also want to know about the other documents in a view before the current `update_seq`. This is supported like this:

``` js
  var Changes = require('changes');
  
  var changes = new Changes({
    url: 'http://user:pass@127.0.0.1:5984/database',
    views: {
      'important': {
        path: '_design/Some/_view/name',
        query: { include_docs: true }
      }
    },
    timeout: {
      max:  60000,
      step: 5000
    }
  });

  //
  // All rows from a queries view will be emitted
  // in the `views:<name>` event **before** the
  // `_changes` listener starts. 
  //
  changes.on('views:important', function (rows) {
    //
    // Dump any existing "important" rows.
    //
    console.dir(rows);
  });
  
  //
  // Dump changes as they come in.
  //
  changes.on('change', function (doc) {
    console.dir(doc);
  });
  
  //
  // The callback will be called once a _changes
  // connection has been established or with an
  // error if the first connection fails.
  //
  changes.listen(function (err) {
    if (err) {
      console.log('Did not connect to _changes on first attempt');
      console.dir(err);
      changes.retry.enabled = false;
      return process.exit(1);
    }
    
    console.log('Listening for _changes');
  });
```

#### License: MIT
#### Authors: [Bradley Meck](https://github.com/bmeck), [Maciej Malecki](https://github.com/mmalecki), [Charlie Robbins](https://github.com/indexzero)