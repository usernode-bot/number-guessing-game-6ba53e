/**
 * usernode-usernames.js — Global username system for Usernode dapps.
 * Vendored from usernode-dapp-starter.
 *
 * Include after usernode-bridge.js. Provides UsernodeUsernames on window:
 *   await UsernodeUsernames.init()
 *   await UsernodeUsernames.setUsername("alice")
 *   UsernodeUsernames.getUsernameSync(pubkey)
 */
(function () {
  'use strict';

  var USERNAMES_PUBKEY =
    (typeof window !== 'undefined' && window.localStorage &&
      window.localStorage.getItem('usernode:usernames_pubkey')) ||
    'ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az';

  var TX_SEND_OPTS = {
    timeoutMs: 180000,
    pollIntervalMs: 1500,
    serverCacheUrl: '/__usernode/cache/' + USERNAMES_PUBKEY,
  };
  var CACHE_TTL_MS = 30000;
  var SERVER_CACHE_URL = '/__usernames/state';

  var cache = new Map();
  var lastFetch = 0;
  var fetchPromise = null;
  var myAddress = null;

  function last6(addr) {
    return addr ? addr.slice(-6) : '';
  }

  function usernameSuffix(addr) {
    return addr ? '_' + last6(addr) : '_unknown';
  }

  function defaultUsername(addr) {
    return addr ? 'user_' + last6(addr) : 'user';
  }

  function normalizeUsername(raw, addr) {
    var suffix = usernameSuffix(addr);
    var maxBase = Math.max(1, 24 - suffix.length);
    var v = String(raw || '')
      .trim()
      .replace(/[^\w-]/g, '');
    if (!v) return defaultUsername(addr);
    if (v.endsWith(suffix)) v = v.slice(0, -suffix.length);
    v = v.replace(/_[A-Za-z0-9]{6}$/, '');
    return (v.slice(0, maxBase) || 'user') + suffix;
  }

  function fetchUsernameTxs() {
    return fetch(SERVER_CACHE_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (!data || typeof data.usernames !== 'object' || data.usernames === null) return;
        var pubkeys = Object.keys(data.usernames);
        for (var i = 0; i < pubkeys.length; i++) {
          var pk = pubkeys[i];
          var name = data.usernames[pk];
          if (typeof name !== 'string' || !name) continue;
          cache.set(pk, { name: name, ts: Date.now() });
        }
        lastFetch = Date.now();
      })
      .catch(function (e) {
        console.warn('UsernodeUsernames: fetch failed:', e.message || e);
      });
  }

  function ensureFresh() {
    if (Date.now() - lastFetch < CACHE_TTL_MS) return Promise.resolve();
    if (fetchPromise) return fetchPromise;
    fetchPromise = fetchUsernameTxs().then(
      function () { fetchPromise = null; },
      function () { fetchPromise = null; }
    );
    return fetchPromise;
  }

  window.UsernodeUsernames = {
    USERNAMES_PUBKEY: USERNAMES_PUBKEY,

    defaultUsername: defaultUsername,
    usernameSuffix: usernameSuffix,
    normalizeUsername: normalizeUsername,

    init: function () {
      return window
        .getNodeAddress()
        .then(function (addr) {
          myAddress = addr || null;
        })
        .catch(function () {})
        .then(fetchUsernameTxs);
    },

    getMyAddress: function () {
      return myAddress;
    },

    getUsername: function (pubkey) {
      return ensureFresh().then(function () {
        var entry = cache.get(pubkey);
        return entry ? entry.name : defaultUsername(pubkey);
      });
    },

    getUsernameSync: function (pubkey) {
      var entry = cache.get(pubkey);
      return entry ? entry.name : defaultUsername(pubkey);
    },

    getAllUsernamesSync: function () {
      var map = {};
      cache.forEach(function (v, k) { map[k] = v.name; });
      return map;
    },

    setUsername: function (baseName) {
      var p = myAddress
        ? Promise.resolve(myAddress)
        : window.getNodeAddress().then(function (a) {
            myAddress = a;
            return a;
          });

      return p.then(function (addr) {
        var value = normalizeUsername(baseName, addr);
        var memo = JSON.stringify({
          app: 'usernames',
          type: 'set_username',
          username: value,
        });
        if (memo.length > 1024) throw new Error('Username too long');
        return window
          .sendTransaction(USERNAMES_PUBKEY, 1, memo, TX_SEND_OPTS)
          .then(function () {
            cache.set(addr, { name: value, ts: Date.now() });
            return value;
          });
      });
    },

    refresh: function () {
      lastFetch = 0;
      return fetchUsernameTxs();
    },

    importLegacy: function (legacyMap) {
      if (!legacyMap) return;
      var entries =
        legacyMap instanceof Map
          ? Array.from(legacyMap.entries())
          : Object.entries(legacyMap);
      for (var i = 0; i < entries.length; i++) {
        var pubkey = entries[i][0];
        var name = entries[i][1];
        if (typeof name === 'object' && name !== null) name = name.name;
        if (!cache.has(pubkey) && name) {
          cache.set(pubkey, { name: String(name), ts: 0 });
        }
      }
    },
  };
})();
