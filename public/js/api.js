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
    deleteNetwork: function (id) { return req('DELETE', '/api/networks/' + encodeURIComponent(id)); },

    config: function () { return req('GET', '/api/config'); },
    saveConfig: function (p) { return req('PUT', '/api/config', p); },
    updateMe: function (p) { return req('PUT', '/api/me', p); },
    testIntegration: function () { return req('POST', '/api/integrations/test'); },

    conversations: function () { return req('GET', '/api/conversations'); },
    createConversation: function (p) { return req('POST', '/api/conversations', p); },
    getConversation: function (id) { return req('GET', '/api/conversations/' + encodeURIComponent(id)); },
    deleteConversation: function (id) { return req('DELETE', '/api/conversations/' + encodeURIComponent(id)); },
    clearConversation: function (id) { return req('PUT', '/api/conversations/' + encodeURIComponent(id), { clear: true }); },

    chatStream: function (payload, onEvent) {
      return new Promise(function (resolve, reject) {
        fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        }).then(async function (r) {
          if (!r.ok) {
            let data = {};
            try { data = await r.json(); } catch (e) { /* ignore */ }
            throw new Error(data.error || '请求失败（' + r.status + '）');
          }
          const reader = r.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buf = '';
          function pump() {
            return reader.read().then(function (res) {
              if (res.done) { resolve(); return; }
              buf += decoder.decode(res.value, { stream: true });
              let i;
              while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line.startsWith('data:')) continue;
                try {
                  const ev = JSON.parse(line.slice(5).trim());
                  if (onEvent) onEvent(ev);
                } catch (e) { /* ignore */ }
              }
              return pump();
            });
          }
          return pump();
        }).catch(function (e) { reject(e); });
      });
    },
    chatExtract: function (id) { return req('POST', '/api/chat/extract', { conversationId: id }); },
    fusionAnalyze: function (p) { return req('POST', '/api/fusion/analyze', p); },
    vision: function (p) { return req('POST', '/api/vision', p); },

    plans: function () { return req('GET', '/api/plans'); },
    createPlan: function (p) { return req('POST', '/api/plans', p); },
    getPlan: function (id) { return req('GET', '/api/plans/' + encodeURIComponent(id)); },
    deletePlan: function (id) { return req('DELETE', '/api/plans/' + encodeURIComponent(id)); },
    runPlanStep: function (pid, sid) { return req('POST', '/api/plans/' + encodeURIComponent(pid) + '/steps/' + encodeURIComponent(sid) + '/run'); },
    setPlanStep: function (pid, sid, p) { return req('PUT', '/api/plans/' + encodeURIComponent(pid) + '/steps/' + encodeURIComponent(sid), p); }
  };
})();
