const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {protocol, checkScheme} = ChromeUtils.import("chrome://juggler/content/protocol/Protocol.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const helper = new Helper();

const PROTOCOL_HANDLERS = {
  Page: ChromeUtils.import("chrome://juggler/content/protocol/PageHandler.js").PageHandler,
  Network: ChromeUtils.import("chrome://juggler/content/protocol/NetworkHandler.js").NetworkHandler,
  Browser: ChromeUtils.import("chrome://juggler/content/protocol/BrowserHandler.js").BrowserHandler,
  Target: ChromeUtils.import("chrome://juggler/content/protocol/TargetHandler.js").TargetHandler,
  Runtime: ChromeUtils.import("chrome://juggler/content/protocol/RuntimeHandler.js").RuntimeHandler,
  Accessibility: ChromeUtils.import("chrome://juggler/content/protocol/AccessibilityHandler.js").AccessibilityHandler,
};

class Dispatcher {
  /**
   * @param {Connection} connection
   */
  constructor(connection) {
    this._connection = connection;
    this._connection.onmessage = this._dispatch.bind(this);
    this._connection.onclose = this._dispose.bind(this);

    this._targetSessions = new Map();
    this._sessions = new Map();
    this._rootSession = new ChromeSession(this, undefined, null /* contentSession */, TargetRegistry.instance().browserTargetInfo());

    this._eventListeners = [
      helper.on(TargetRegistry.instance(), TargetRegistry.Events.TargetDestroyed, this._onTargetDestroyed.bind(this)),
    ];
  }

  async createSession(targetId) {
    const targetInfo = TargetRegistry.instance().targetInfo(targetId);
    if (!targetInfo)
      throw new Error(`Target "${targetId}" is not found`);
    let targetSessions = this._targetSessions.get(targetId);
    if (!targetSessions) {
      targetSessions = new Map();
      this._targetSessions.set(targetId, targetSessions);
    }

    const sessionId = helper.generateId();
    const contentSession = targetInfo.type === 'page' ? new ContentSession(this, sessionId, targetInfo) : null;
    const chromeSession = new ChromeSession(this, sessionId, contentSession, targetInfo);
    targetSessions.set(sessionId, chromeSession);
    this._sessions.set(sessionId, chromeSession);
    this._emitEvent(this._rootSession._sessionId, 'Target.attachedToTarget', {
      sessionId: sessionId,
      targetInfo
    });
    return sessionId;
  }

  _dispose() {
    helper.removeListeners(this._eventListeners);
    this._connection.onmessage = null;
    this._connection.onclose = null;
    this._rootSession.dispose();
    this._rootSession = null;
    for (const session of this._sessions.values())
      session.dispose();
    this._sessions.clear();
    this._targetSessions.clear();
  }

  _onTargetDestroyed({targetId}) {
    const sessions = this._targetSessions.get(targetId);
    if (!sessions)
      return;
    this._targetSessions.delete(targetId);
    for (const [sessionId, session] of sessions) {
      session.dispose();
      this._sessions.delete(sessionId);
    }
  }

  async _dispatch(event) {
    const data = JSON.parse(event.data);
    const id = data.id;
    const sessionId = data.sessionId;
    delete data.sessionId;
    try {
      const session = sessionId ? this._sessions.get(sessionId) : this._rootSession;
      if (!session)
        throw new Error(`ERROR: cannot find session with id "${sessionId}"`);
      const method = data.method;
      const params = data.params || {};
      if (!id)
        throw new Error(`ERROR: every message must have an 'id' parameter`);
      if (!method)
        throw new Error(`ERROR: every message must have a 'method' parameter`);

      const [domain, methodName] = method.split('.');
      const descriptor = protocol.domains[domain] ? protocol.domains[domain].methods[methodName] : null;
      if (!descriptor)
        throw new Error(`ERROR: method '${method}' is not supported`);
      let details = {};
      if (!checkScheme(descriptor.params || {}, params, details))
        throw new Error(`ERROR: failed to call method '${method}' with parameters ${JSON.stringify(params, null, 2)}\n${details.error}`);

      const result = await session.dispatch(method, params);

      details = {};
      if ((descriptor.returns || result) && !checkScheme(descriptor.returns, result, details))
        throw new Error(`ERROR: failed to dispatch method '${method}' result ${JSON.stringify(result, null, 2)}\n${details.error}`);

      this._connection.send(JSON.stringify({id, sessionId, result}));
    } catch (e) {
      this._connection.send(JSON.stringify({id, sessionId, error: {
        message: e.message,
        data: e.stack
      }}));
    }
  }

  _emitEvent(sessionId, eventName, params) {
    const [domain, eName] = eventName.split('.');
    const scheme = protocol.domains[domain] ? protocol.domains[domain].events[eName] : null;
    if (!scheme)
      throw new Error(`ERROR: event '${eventName}' is not supported`);
    const details = {};
    if (!checkScheme(scheme, params || {}, details))
      throw new Error(`ERROR: failed to emit event '${eventName}' ${JSON.stringify(params, null, 2)}\n${details.error}`);
    this._connection.send(JSON.stringify({method: eventName, params, sessionId}));
  }
}

class ChromeSession {
  /**
   * @param {Connection} connection
   */
  constructor(dispatcher, sessionId, contentSession, targetInfo) {
    this._dispatcher = dispatcher;
    this._sessionId = sessionId;
    this._contentSession = contentSession;
    this._targetInfo = targetInfo;

    this._handlers = {};
    for (const [domainName, handlerFactory] of Object.entries(PROTOCOL_HANDLERS)) {
      if (protocol.domains[domainName].targets.includes(targetInfo.type))
        this._handlers[domainName] = new handlerFactory(this, contentSession);
    }
  }

  dispatcher() {
    return this._dispatcher;
  }

  targetId() {
    return this._targetInfo.targetId;
  }

  dispose() {
    if (this._contentSession)
      this._contentSession.dispose();
    this._contentSession = null;
    for (const [domainName, handler] of Object.entries(this._handlers)) {
      if (!handler.dispose)
        throw new Error(`Handler for "${domainName}" domain does not define |dispose| method!`);
      handler.dispose();
      delete this._handlers[domainName];
    }
    // Root session don't have sessionId and don't emit detachedFromTarget.
    if (this._sessionId) {
      this._dispatcher._emitEvent(this._sessionId, 'Target.detachedFromTarget', {
        sessionId: this._sessionId,
      });
    }
  }

  emitEvent(eventName, params) {
    this._dispatcher._emitEvent(this._sessionId, eventName, params);
  }

  async dispatch(method, params) {
    const [domainName, methodName] = method.split('.');
    if (!this._handlers[domainName])
      throw new Error(`Domain "${domainName}" does not exist`);
    if (!this._handlers[domainName][methodName])
      throw new Error(`Handler for domain "${domainName}" does not implement method "${methodName}"`);
    return await this._handlers[domainName][methodName](params);
  }
}

class ContentSession {
  constructor(dispatcher, sessionId, targetInfo) {
    this._dispatcher = dispatcher;
    const tab = TargetRegistry.instance().tabForTarget(targetInfo.targetId);
    this._browser = tab.linkedBrowser;
    this._messageId = 0;
    this._pendingMessages = new Map();
    this._sessionId = sessionId;
    this._browser.messageManager.sendAsyncMessage('juggler:create-content-session', this._sessionId);
    this._disposed = false;
    this._eventListeners = [
      helper.addMessageListener(this._browser.messageManager, this._sessionId, {
        receiveMessage: message => this._onMessage(message)
      }),
    ];
  }

  isDisposed() {
    return this._disposed;
  }

  dispose() {
    if (this._disposed)
      return;
    this._disposed = true;
    helper.removeListeners(this._eventListeners);
    for (const {resolve, reject, methodName} of this._pendingMessages.values())
      reject(new Error(`Failed "${methodName}": Page closed.`));
    this._pendingMessages.clear();
    if (this._browser.messageManager)
      this._browser.messageManager.sendAsyncMessage('juggler:dispose-content-session', this._sessionId);
  }

  /**
   * @param {string} methodName
   * @param {*} params
   * @return {!Promise<*>}
   */
  send(methodName, params) {
    const id = ++this._messageId;
    const promise = new Promise((resolve, reject) => {
      this._pendingMessages.set(id, {resolve, reject, methodName});
    });
    this._browser.messageManager.sendAsyncMessage(this._sessionId, {id, methodName, params});
    return promise;
  }

  _onMessage({data}) {
    if (data.id) {
      let id = data.id;
      const {resolve, reject} = this._pendingMessages.get(data.id);
      this._pendingMessages.delete(data.id);
      if (data.error)
        reject(new Error(data.error));
      else
        resolve(data.result);
    } else {
      const {
        eventName,
        params = {}
      } = data;
      this._dispatcher._emitEvent(this._sessionId, eventName, params);
    }
  }
}


this.EXPORTED_SYMBOLS = ['Dispatcher'];
this.Dispatcher = Dispatcher;

