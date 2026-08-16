(function () {
  'use strict';
  async function req(method, url, body) {
    const opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) {
      const err = new Error(data.error || '请求失败（' + r.status + '）');
      err.status = r.status;
      throw err;
    }
    return data;
  }
  window.Api = {
    me: function () { return req('GET', '/api/me'); },
    register: function (p) { return req('POST', '/api/auth/register', p); },
    login: function (p) { return req('POST', '/api/auth/login', p); },
    logout: function () { return req('POST', '/api/auth/logout'); },
    templates: function () { return req('GET', '/api/templates'); },
    networks: function () { return req('GET', '/api/networks'); },
    createNetwork: function (p) { return req('POST', '/api/networks', p); },
    getNetwork: function (id) { return req('GET', '/api/networks/' + encodeURIComponent(id)); },
    updateNetwork: function (id, p) { return req('PUT', '/api/networks/' + encodeURIComponent(id), p); },
    deleteNetwork: function (id) { return req('DELETE', '/api/networks/' + encodeURIComponent(id)); }
  };
})();
