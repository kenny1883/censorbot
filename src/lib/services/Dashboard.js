const Express = require('express')
const Request = require('../../../req')
const crypto = require('crypto')

const bit = 0x0000008

const Logger = require('../../../util/Logger')
const Collection = require('../../../util/Collection')
const encodeJSON = require('../../../util/encodeJSON')
const validateObject = require('../../../util/validateObject')

const cacheTimeout = 300000

const Database = require('./Database')

const UpdatesManager = require('../client/UpdatesManager')
const CommandHandler = require('../bot/CommandHandler')

const config = require('../../config')

/**
 * Guilds cached for oauth/dashboard use
 * @typedef {Object} CachedGuild
 * @property {Snowflake} i ID of guild
 * @property {String} n Name of guild
 * @property {String} a Icon hash of guild
 * @property {Array.<Channel>} c Channels
 * @property {Array.<Role>} r Roles
 */

/**
  * Used for retrieving OAuth bearer of a Discord user
  * @typedef {String} OAuthCode
  */
/**
  * Used for requesting as a user, such as user info and guilds
  * @typedef {String} OAuthBearer
  */

/**
 * Used for methods used throughout the api and dashboard
 */
class Dashboard {
  /**
   * Dashboard
   * @param {DashboardWorker} worker Dashboard Worker
   */
  constructor (worker) {
    /**
     * Internal Methods
     * @type {WorkerInternals}
     */
    this.cluster = worker.internals

    /**
     * Config
     * @type {Object}
     */
    this.config = config

    /**
     * Updates
     * @type {UpdateManager}
     */
    this.updates = new UpdatesManager(this)

    /**
     * Express app
     * @type {?Express}
     */
    this.app = null

    /**
     * HTTP Server
     * @type {?Server}
     */
    this.server = null

    /**
     * Ran on ready
     * @type {?Function}
     */
    this.onReady = null

    /**
     * Guild cache
     * @type {Collection.<Snowflake, Array.<CachedGuild>>}
     */
    this.guilds = new Collection()

    /**
     * Clear cachings
     * @type {Collection.<Snowflake, Timeout>}
     */
    this.caching = new Collection()

    /**
     * Blank discord api
     * @type {Request}
     */
    this.api = Request('https://discord.com/api')

    /**
     * Base URL
     * @type {String}
     */
    this.base = 'https://dash.censor.bot'

    /**
     * API URL
     * @type {String}
     */
    this.apiUrl = 'https://api.censor.bot'

    /**
     * Database
     * @type {Database}
     */
    this.database = null

    /**
     * Logger
     * @type {Logger}
     */
    this.logger = new Logger('Dash')

    this.commands = new CommandHandler(this)

    /**
     * Censor Bot API
     * @type {Request}
     */
    this.capi = Request('https://censor.bot', {}, { format: 'text' })

    this.connectDatabase()
  }

  /**
   * log
   * @param  {...any} _ log
   */
  log (..._) {
    this.logger.log(..._)
  }

  /**
   * Connects database
   */
  connectDatabase () {
    this.database = new Database(this, config.db.username, config.db.password)
    this.database.connect()
  }

  /**
   * Database
   * @type {MongoDB.Collection}
   */
  get db () {
    return this.database.collection('dashboard')
  }

  /**
   * Spawn dashboard
   * @returns {Promise}
   */
  spawn () {
    this.log(0, 0, 'Dashboard')
    return new Promise(resolve => {
      const start = new Date().getTime()
      this.onReady = () => {
        this.onReady = null
        resolve()
        this.log(0, 1, 'Dashboard', `${new Date().getTime() - start}ms:${config.port}`)
      }
      this.start()
    })
  }

  /**
   * Start app
   */
  start () {
    this.app = Express()

    this.load()

    this.server = this.app.listen(config.port, () => {
      this.onReady()
    })
  }

  /**
   * Close server
   */
  close () {
    this.server.close()
  }

  /**
   * Load routes
   */
  load () {
    this.app.use(
      require('../../dashboard')(this)
    )
  }

  /**
   * Reload routes
   */
  reload () {
    delete require.cache[require.resolve('../../dashboard')]
    this.app._router = null
    this.load()
  }

  /**
   * Redirect URL
   * @type {String}
   */
  get redirectURL () {
    return this.base + '/auth/callback'
  }

  /**
   * OAUTH Login url
   * @param {String} state Redirect state
   * @returns {String} URL to send to
   */
  oauthLogin (state) {
    const oauth = config.oauth

    return 'https://discord.com/api/oauth2/authorize?' +
      encodeJSON({
        client_id: oauth.id,
        redirect_uri: this.redirectURL,
        response_type: 'code',
        scope: 'identify guilds',
        ...(state ? { state: state } : {})
      })
  }

  // caching

  /**
   * Get user in cache
   * @param {Snowflake} user User
   * @returns {Array.<CachedGuild>} Guilds
   */
  getInCache (user) {
    const cache = this.guilds.get(user)

    if (!cache) return false

    const timeout = this.caching.get(user)

    clearTimeout(timeout)

    this.caching.set(user, setTimeout(() => {
      this.guilds.delete(user)
      this.caching.delete(user)
    }, cacheTimeout))

    return cache
  }

  /**
   * Set guilds into user cache
   * @param {Snowflake} user User
   * @param {Array.<CachedGuild>} value Guilds
   */
  setInCache (user, value) {
    this.guilds.set(user, value)
    this.caching.set(user, setTimeout(() => {
      this.guilds.delete(user)
      this.caching.delete(user)
    }, cacheTimeout))
  }

  // auth

  /**
   * Fail a request unauthorized
   * @param {*} res Res
   * @param {Boolean} api Whether api
   * @param {String} state OAuth State
   */
  fail (res, api, state) {
    if (api) res.json({ error: 'Unauthorized' })
    else res.redirect(this.oauthLogin(state))
  }

  /**
   * Get user guilds
   * @returns {Promise.<Array.<CachedGuild>>} User Guilds
   */
  async getGuilds (req, state, api = false) {
    const { res } = req

    const token = api ? req.headers.authorization : req.cookies.token

    if (!token) {
      this.fail(res, api, state)
      return false
    }

    const guilds = await this.getUserGuilds(token, res, state, api)
    if (!guilds) return false

    return guilds
  }

  async isAdmin (id) {
    const response = await this.capi
      .admin[id]
      .get()

    return !!parseInt(response)
  }

  /**
   * Get made user guilds
   * @param {String} token User token
   * @param {*} res Res
   * @param {String} state State
   * @param {Boolean} api API
   * @returns {Promise.<Array.<CachedGuild>>} User Guilds
   */
  async getUserGuilds (token, res, state, api) {
    const user = await this.db.findOne({
      token: token
    })

    if (!user) {
      this.fail(res, api, state)
      return false
    }

    const isAdmin = await this.isAdmin(user.id)

    const cache = this.getInCache(user.id)
    if (cache && isAdmin && state && !cache.some(x => x.i === state)) {
      cache.push({
        i: state,
        n: '(ADMIN)',
        a: null
      })
    }
    if (cache) return cache

    const guilds = await this.fetchGuilds(user.bearer, res, state, api)
    if (!guilds) return false

    this.setInCache(user.id, guilds)

    if (state && !guilds.some(x => x.i === state)) {
      guilds.push({
        i: state,
        n: '(ADMIN)',
        a: null
      })
    }
    return guilds
  }

  /**
   * Fetch user guilds
   * @param {String} bearer User bearer
   * @param {*} res Res
   * @param {String} state State
   * @param {Boolean} api API
   * @returns {Promise<Array.<CachedGuild>>} Guilds
   */
  async fetchGuilds (bearer, res, state, api) {
    const guilds = await this.api
      .users('@me')
      .guilds
      .get({
        headers: {
          Authorization: `Bearer ${bearer}`
        }
      })
    if (!guilds || !guilds[0]) {
      this.fail(res, api, state)
      return false
    }

    return guilds
      .filter(x => ((x.permissions & bit) !== 0 || x.owner))
      .map(x => {
        return { n: x.name, i: x.id, a: x.icon }
      })
  }

  /**
   * Fetch user
   * @param {OAuthBearer} bearer User bearer
   * @returns {Object} User
   */
  async fetchUser (bearer) {
    const user = await this.api
      .users['@me']
      .get({
        headers: {
          Authorization: `Bearer ${bearer}`
        }
      })

    if (!user || !user.id) return false
    return user
  }

  /**
   * New token
   * @type {String}
   */
  get newToken () {
    return crypto.createHash('sha256').update(`${Math.random()}`).update(`${new Date().getTime()}`).update(config.oauth.mysecret).digest('hex')
  }

  // oauth

  /**
   * Handle callback
   * @param {*} req Req
   */
  async callback (req) {
    const { res } = req

    if (!req.query.code) return res.json({ error: 'No code' })

    const oauthUser = await this.fetchOAuthUser(req.query.code)
    if (!oauthUser) return res.redirect(this.oauthLogin(req.query.state))

    const user = await this.fetchUser(oauthUser.access_token)
    if (!user) return res.redirect(this.oauthLogin(req.query.state))

    let token

    const dbUser = await this.db.findOne({
      id: user.id
    })
    if (dbUser) {
      token = dbUser.token
    } else {
      token = this.newToken
    }

    await this.db.updateOne({
      id: user.id
    }, {
      $set: {
        id: user.id,
        tag: `${user.username}#${user.discriminator}`,
        token,
        bearer: oauthUser.access_token
      }
    }, {
      upsert: true
    })

    res.cookie('token', token)

    res.redirect(this.base + (req.query.state ? `/${req.query.state}` : ''))
  }

  /**
   * Fetch oauth user
   * @param {OAuthCode} code Discord code
   * @returns {Object} OAuth user
   */
  async fetchOAuthUser (code) {
    const oauth = config.oauth

    const user = await this.api
      .oauth2
      .token
      .post({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: {
          client_id: oauth.id,
          client_secret: oauth.secret,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: this.redirectURL,
          scope: 'identify guilds'
        },
        parser: encodeJSON
      })
    if (!user || !user.access_token) return false
    return user
  }

  // settings

  /**
   * Guild middleware
   * @param {Boolean} api Whether api or not
   * @returns {Function} For middleware usage
   */
  getGuild (api) {
    return async (req, res, next) => {
      const id = req.params.serverid

      const guilds = await this.getGuilds(req, id, api)
      if (!guilds) return

      const g = guilds.find(x => x.i === id)
      if (!g) return api ? res.json({ error: 'Invalid Guild' }) : res.render('errors/server', { base: this.base })

      req.partialGuild = g
      next()
    }
  }

  /**
   * Get guild data middleware
   * @param {Boolean} api Whether api or not
   * @param {Function} fn Callback
   * @returns {Function} For middleware usage
   */
  guildData (api, fn) {
    return async (req, res) => {
      const { i: id, n: name } = req.partialGuild
      const guild = await this.cluster.fetchGuild(id)
      if (!guild) return api ? res.json({ error: 'Not In Guild' }) : res.render('invite', { id })

      const obj = { id, name }

      obj.c = guild.c
      obj.r = guild.r

      obj.db = await this.database.config(id)

      fn(req, res, obj)
    }
  }

  /**
   * Validate posted settings
   * @param {Object} obj Posted object
   * @param {Object} guild Guild data
   * @param {Function} f Ran on failure with string
   * @returns {?Boolean}
   */
  validateSettings (obj, guild, f) {
    if (!validateObject(this.database.defaultConfig, obj)) return f('Invalid Object')
    if (typeof obj.base !== 'boolean') return f('Base has an invalid type')
    if (typeof obj.censor.msg !== 'boolean') return f('Censor (msg) has an invalid type')
    if (typeof obj.censor.emsg !== 'boolean') return f('Censor (emsg) has an invalid type')
    if (typeof obj.censor.nick !== 'boolean') return f('Censor (nick) has an invalid type')
    if (typeof obj.censor.react !== 'boolean') return f('Censor (react) has an invalid type')
    if (obj.log !== null && ((typeof obj.log !== 'string') || !guild.c.some(x => x.id === obj.log))) return f('Log does not exist on server')
    if ((typeof obj.role !== 'string' && obj.role !== null) || (typeof obj.role === 'string' && !guild.r.some(x => x.id === obj.role))) return f('Role does not exist on server')
    if (!(obj.filter instanceof Array)) return f('Filter has an invalid type')
    if (obj.filter.some(x => x.match(/[^\w]/gi))) return f('A filter entree contains illegal characters')
    if (obj.pop_delete !== null && typeof obj.pop_delete !== 'number') return f('Pop delete has an invalid type')
    if (![0, 1, 2, 3].includes(obj.punishment.type)) return f('Punishment type chosen does not exist')
    if (![0, 1].includes(obj.webhook_replace)) return f('Webhook replace is not valid')
    if (typeof obj.punishment.amount !== 'number' || obj.punishment.amount < 1) return f('Punishment amount cannot be less than 1')
    if ((typeof obj.punishment.role !== 'string' && obj.punishment.role !== null) || (typeof obj.punishment.role === 'string' && !guild.r.some(x => x.id === obj.punishment.role))) return f('Punishment role does not exist on server')
    if (typeof obj.webhook !== 'boolean') return f('Resend has an invalid type')
    if (!(obj.channels instanceof Array)) return f('Ignore channels is an invalid type')
    if (obj.channels.some(x => !guild.c.some(c => c.id === x))) return f('One of the uncensor channels does not exist on server')
    if (!(obj.uncensor instanceof Array)) return f('Uncensor is an invalid type')
    if (obj.uncensor.some(x => x.match(/[^\w]/gi))) return f('One of the uncensor words contains illegal characters')
    if (typeof obj.multi !== 'boolean') return f('Multi-Line is an invalid type')
    if (!(obj.languages instanceof Array)) return f('Languages is an invalid type')
    if (obj.languages.some(x => !this.database.defaultConfig.languages.includes(x))) return f('Languages contains an invalid language')
    if (typeof obj.webhook_separate !== 'boolean') return f('Webhook Separate is not a boolean')
    if (obj.prefix.length > 15) return f('Prefix is too long')
    return true
  }

  // premium

  /**
   * Get premium object
   * @param {Snowflake} id User
   * @returns {Object} Premium object
   */
  async premium (id) {
    const premium = parseInt(await this
      .capi
      .premium[id]
      .get()
    )
    if (premium < 1) return { premium: false }

    const user = { premium: true, amount: premium }

    const dbUser = await this.database.collection('premium_users').findOne({ id })

    if (!dbUser) {
      await this.database.collection('premium_users').updateOne({ id }, {
        $set: {
          id,
          guilds: []
        }
      })
      user.guilds = []
    } else user.guilds = dbUser.guilds

    return user
  }

  /**
   * Premium middleware
   * @param {Boolean} api Whether API
   * @param {Function} fn Callback function
   */
  premiumMiddle (api, fn) {
    return async (req, res, next) => {
      const user = await this.db.findOne({ token: api ? req.headers.authorization : req.cookies.token })

      if (!user) return api ? res.json({ error: 'Unauthorized' }) : res.redirect(this.oauthLogin('premium'))

      const prem = await this.premium(user.id)
      if (!prem.premium) return api ? res.json({ error: 'Not premium' }) : res.render('errors/notpremium')

      req.user = user
      req.premium = prem

      if (!fn) return next()

      const guilds = await this.getGuilds(req, 'premium')
      if (!guilds) return

      fn(req, res, user, prem, guilds)
    }
  }

  // admin

  /**
   * Admin middleware
   * @param {Boolean} api Whether API
   * @param {Function} fn Callback
   */
  adminMiddle (api, fn) {
    return async (req, res, next) => {
      const user = await this.db.findOne({ token: api ? req.headers.authorization : req.cookies.token })

      if (!user) return api ? res.json({ error: 'Unauthorized' }) : res.redirect(this.oauthLogin('admin'))

      const admin = await this.isAdmin(user.id)

      if (!admin) return api ? res.json({ error: 'Not Admin' }) : res.render('errors/notadmin', { base: this.base })

      req.user = user

      fn ? fn(req, res) : next()
    }
  }
}

module.exports = Dashboard
