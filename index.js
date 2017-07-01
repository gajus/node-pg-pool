"use strict"
var util = require('util')
var EventEmitter = require('events').EventEmitter

var Pool = module.exports = function (options, Client) {
  if (!(this instanceof Pool)) {
    return new Pool(options, Client)
  }
  EventEmitter.call(this)
  this.options = Object.assign({}, options)
  this.log = this.options.log || function () { }
  this.Client = this.options.Client || Client || require('pg').Client
  this.Promise = this.options.Promise || global.Promise
  this._clients = []
  this._idle = []
  this._pendingQueue = []
  this._ending = false

  this.options.max = this.options.max || this.options.poolSize || 10
}

util.inherits(Pool, EventEmitter)

Pool.prototype._pulseQueue = function () {
  if (!this._pendingQueue.length) {
    return
  }
  if (!this._idle.length) {
    return
  }
  const client = this._idle.pop()
  const waiter = this._pendingQueue.shift()
  waiter(null, client)
}

const promisify = callback => {
  if (callback) {
    return { callback: callback, result: undefined }
  }
  let reject = undefined
  let resolve = undefined
  const cb = function (err, client) {
    err ? reject(err) : resolve(client)
  }
  const result = new Promise(function (res, rej) {
    resolve = res
    reject = rej
  })
  return { callback: cb, result: result }
}

Pool.prototype.connect = function (cb) {
  if (this._ending) {
    const err = new Error('Cannot use a pool after calling end on the pool')
    return cb ? cb(err) : Promise.reject(err)
  }
  if (this._clients.length >= this.options.max) {
    const response = promisify(cb)
    const result = response.result
    cb = response.callback
    this._pendingQueue.push((err, client) => {
      const release = () => {
        client.release = function () { throw new Error('called release twice') }
        this._idle.push(client)
        this._pulseQueue()
      }
      client.release = release
      this.emit('acquire', client)
      cb(err, client, release)
    })
    this._pulseQueue()
    return result
  }

  const client = new this.Client(this.options)
  this._clients.push(client)
  const idleListener = (err) => {
    err.client = client
    this.emit('error', err, client)
    client.removeListener('error', idleListener)
    client.on('error', () => {
      this.log('additional client error after disconnection due to error', err)
    })
    client.end()
  }

  const response = promisify(cb)
  const result = response.result
  cb = response.callback
  this.log('connecting new client', this.options)
  client.connect((err) => {
    this.log('new client connected')
    const release = () => {
      client.release = function () { throw new Error('called release twice') }
      this._idle.push(client)
      this._pulseQueue()
    }
    client.on('error', idleListener)
    if (err) {
      cb(err, undefined, function() { })
    } else {
      client.release = release
      this.emit('connect', client)
      this.emit('acquire', client)
      cb(undefined, client, release)
    }
  })
  return result
}

Pool.prototype.query = function (text, values, cb) {
  if (typeof values == 'function') {
    cb = values
    values = undefined
  }
  const response = promisify(cb)
  cb = response.callback
  this.connect(function (err, client) {
    if (err) {
      return cb(err)
    }
    client.query(text, values, function (err, res) {
      client.release(err)
      if (err) {
        return cb(err)
      } else {
        return cb(undefined, res)
      }
    })
  })
  return response.result
}

Pool.prototype.end = function (cb) {
  if (this._ending) {
    const err = new Error('Called end on pool more than once')
    return cb ? cb(err) : Promise.reject(err)
  }
  this._ending = true
  const promises = this._clients.map(client => client.end())
  if (!cb) {
    return Promise.all(promises)
  }
  Promise.all(promises)
    .then(() => cb ? cb() : undefined)
    .catch(err => {
      cb(err)
    })
}

Object.defineProperty(Pool.prototype, 'waitingCount', {
  get: function () {
    return this._pendingQueue.length
  }
})

Object.defineProperty(Pool.prototype, 'idleCount', {
  get: function () {
    return this._idle.length
  }
})

Object.defineProperty(Pool.prototype, 'totalCount', {
  get: function () {
    return this._clients.length
  }
})
