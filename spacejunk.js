#!/usr/bin/env node

/* TODO Move all this logic to a server-side plugin. Instead of monkeypatching
 * fs, do something similar to the FileSystemAdaptor (git.io/qhdgVQ). The
 * problem is that some functions from boot.js (git.io/bghfxQ) would still need
 * to be overridden somehow. That would allow us to deprecate this package and
 * the main app could use the default TiddlyWiki package */

var  $tw = require("tiddlywiki/boot/boot.js").TiddlyWiki(),
 Dropbox = require("dropbox"),
    sync = require("synchronize"),
      fs = require("fs"),
    path = require("path");

var config, appname, dropboxPath, tiddlersPathSuffix = "/tiddlers/";

try {
  config = require(path.join(process.cwd(), "config.json"));
} catch (e) {
  console.info("No custom configurations were found.");
  config = {};
} finally {
  config.dropbox = config.dropbox || {};
  config.auth = config.auth || {};
}

// Pass the command line arguments to the boot kernel
$tw.boot.argv = Array.prototype.slice.call(process.argv, 2);

// If the env var SPACEJUNK_LOCAL is set, run TiddlyWiki without Dropbox sync
if (process.env.SPACEJUNK_LOCAL == "true") {
  return $tw.boot.boot();
}

// Create a volume with your credentials
var dropbox = new Dropbox.Client({
  key: (process.env.DROPBOX_KEY || config.dropbox.key),
  secret: (process.env.DROPBOX_SECRET || config.dropbox.secret),
  token: (process.env.DROPBOX_TOKEN || config.dropbox.token)
});

// Allow these functions to be called synchronously (only used on boot!)
sync(dropbox, 'readdir', 'readFile', 'stat');

function monkeypatch(object, f, callback) {
  object[f] = callback(object[f]);
}

// Checks if a local path should be mapped to a remote (dropbox) path
// @param {String} operation that will be performed (read, write or delete)
function shouldBeRemotePath(filepath, operation) {
  var isTiddlersPath = (filepath + "/").indexOf(tiddlersPathSuffix) != -1;

  switch (operation) {
    case "write":
    case "delete":
      // Changes and deleted tiddlers are synced with Dropbox
      return isTiddlersPath;
    case "read":
      // Users will always see the last changes from Dropbox
      return isTiddlersPath;
    default:
      return isTiddlersPath;
  }
}

// Converts the local path to the remote (dropbox) path
function toRemotePath(filepath) {
  return filepath.replace(process.cwd(), dropboxPath);
}

// Monkeypatch calls to the filesystem
// TODO Create a custom file sync adaptor for TW5 instead of monkeypatching
monkeypatch(fs, 'readdirSync', function(original) {
  return function (filepath) {
    if (shouldBeRemotePath(filepath, "read")) {
      return dropbox.readdir(toRemotePath(filepath), { "httpCache": true });
    } else {
      return original.apply(this, arguments);
    }
  };
});

monkeypatch(fs, 'readdir', function(original) {
  return function (filepath, callback) {
    if (shouldBeRemotePath(filepath, "read")) {
      return dropbox.readdir(toRemotePath(filepath), { "httpCache": true }, callback);
    } else {
      return original.apply(this, arguments);
    }
  };
});

monkeypatch(fs, 'readFileSync', function(original) {
  return function (filepath, options) {
    if (shouldBeRemotePath(filepath, "read")) {
      return dropbox.readFile(toRemotePath(filepath), { "httpCache": true });
    } else {
      return original.apply(this, arguments);
    }
  };
});

monkeypatch(fs, 'writeFile', function(original) {
  return function(filepath, content, options, callback) {
    if (shouldBeRemotePath(filepath, "write")) {
      return dropbox.writeFile(toRemotePath(filepath), content, callback);
    } else {
      return original.apply(this, arguments);
    }
  };
});

monkeypatch(fs, 'unlink', function(original) {
  return function(filepath, callback) {
    if (shouldBeRemotePath(filepath, "delete")) {
      // This operation may fail sometimes due to parallel requests
      try { return dropbox.unlink(toRemotePath(filepath), callback); }
      catch (error) { console.error("Unable to unlink file from Dropbox."); }
    } else {
      return original.apply(this, arguments);
    }
  };
});

monkeypatch(fs, 'existsSync', function(original) {
  return function (filepath) {
    if (shouldBeRemotePath(filepath, "read")) {
      // Check if there is a file or folder with this name
      // TODO Use findByName instead?
      try { dropbox.stat(toRemotePath(filepath), { "httpCache": true }); return true; }
      catch (error) { return false; } // TODO Check error status
    } else {
      return original.apply(this, arguments);
    }
  };
});

monkeypatch(fs, 'statSync', function(original) {
  return function (filepath) {
    if (shouldBeRemotePath(filepath, "read")) {
      var metadata = dropbox.stat(toRemotePath(filepath), { "httpCache": true });
      metadata.isDirectory = function() { return this.isFolder; };
      metadata.isFile = function() { return this.isFile; };
      return metadata;
    } else {
      return original.apply(this, arguments);
    }
  };
});

/* TODO Find a reasonable way to do this. `boot.js` does things synchronously,
 * and that's why we need some calls to be synchronous. Nevertheless, this is
 * almost certainly not a good idea :P */
sync.fiber(function() {
  // Path to where files are stored
  appname = process.env.APP_NAME || config.appname || "unknown";
  dropboxPath = process.env.DROPBOX_PATH || config.dropbox.path || ("/Apps/Heroku/"+ appname);

  console.info("Booting! Please wait...");

  // Check if app is synced with Dropbox (otherwise this will halt the server)
  // TODO Find a better way to check if Heroku & Dropbox are synced!
  dropbox.stat(dropboxPath);

  // Boot the TW5 app
  $tw.boot.boot();

  console.info("Boot completed. TiddlyWiki is now serving the application.");
});
