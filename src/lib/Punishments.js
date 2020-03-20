// Punishments manager

class PunishmentsHandler {
  constructor (client) {
    client.log(0, 0, 'Punishments')
    this.client = client
    this.db = client.db.collection('punishments')
    this.client.log(0, 1, 'Punishments')
  }

  async punish (guild, user, db, warning, inDB) {
    if (inDB) {
      await this.db.removeOne({
        u: user,
        g: guild
      })
    }

    if (!db.log) return

    const embed = this.client.embed
      .title('User Punished')
      .color('RED')
      .footer('This system is heavily WIP!')

    let cont = true

    switch (db.punishment.type) {
      case 1:
        if (!await this.client.api
          .guilds[guild]
          .members[user]
          .roles[db.punishment.role]
          .put()
          .then(x => x.success)
        ) cont = false
        embed.description(`<@${user}> Reached the max ${db.punishment.amount} warnings.\n\nThey have received the <@&${db.punishment.role}> role as punishment!`)
        break
      case 2:
        if (!await this.client.api
          .guilds[guild]
          .members[user]
          .delete({
            reason: 'Reaching max warnings'
          })
          .then(x => x.success)
        ) cont = false
        embed.description(`<@${user}> Reached the max ${db.punishment.amount} warnings.\n\nThey have been kicked from the server!`)
        break
      case 3:
        if (!await this.client.api
          .guilds[guild]
          .bans[user]
          .put({
            query: {
              reason: 'Reached max warnings'
            }
          })
          .then(x => x.success)
        ) cont = false
        embed.description(`<@${user}> Reached the max ${db.punishment.amount} warnings.\n\nThey have been banned from the server!`)
        break
    }

    if (!cont) return

    this.client.sendMessage(db.log, embed)
  }

  async addOne (guild, user, db) {
    if (db.punishment.type === 0) return
    let inDB = true
    let puser = await this.db.findOne({
      u: user,
      g: guild
    })
    if (!puser) {
      inDB = false
      puser = {
        u: user,
        g: guild,
        a: 0
      }
    }
    puser.a++
    if (puser.a >= db.punishment.amount) {
      this.punish(guild, user, db, puser.a, inDB)
    } else {
      this.db.updateOne({
        g: guild,
        u: user
      }, { $set: puser }, {
        upsert: true
      })
    }
  }
}

module.exports = PunishmentsHandler

/**
 * 0: none
 * 1: mute
 * 2: kick
 * 3: ban
 */