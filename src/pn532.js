'use strict'
var util = require('util')
var EventEmitter = require('events').EventEmitter

var setupLogging = require('./logs')
setupLogging('debug')
// setupLogging(process.env.PN532_LOGGING)
var logger = require('winston').loggers.get('pn532')

var FrameEmitter = require('./frame_emitter').FrameEmitter
var frame = require('./frame')
var DataFrame = frame.DataFrame
var AckFrame = frame.AckFrame
var c = require('./constants')

class PN532 extends EventEmitter {
    /*
        @constructor
        @param {object} hal - An instance of node-serialport's SerialPort or node-i2c's i2c
    */
  constructor (hal, options) {
    super()
    options = options || {}
    this.pollInterval = options.pollInterval || 1000

    if (hal.constructor.name === 'SerialPort') {
      var PN532_UART = require('./pn532_uart')
      this.hal = new PN532_UART(hal)
    } else if (hal.constructor.name === 'i2c') {
      var PN532_I2C = require('./pn532_i2c')
      this.hal = new PN532_I2C(hal)
    } else {
      throw new Error('Unknown hardware type: ', hal.constructor.name)
    }

    this.frameEmitter = new FrameEmitter(this.hal)
    this.hal.init().then(() => {
      this.configureSecureAccessModule().then(() => this.emit('ready'))
    })

    this.on('newListener', (event) => {
            // TODO: Only poll once (for each event type)
      if (event === 'tag') {
        logger.debug('Polling for tag scans...')
        var scanTag = () => {
          this.scanTag().then((tag) => {
            this.emit('tag', tag)
            setTimeout(() => scanTag(), this.pollInterval)
          })
        }
        scanTag()
      }
    })
  }

  sendCommand (commandBuffer) {
    return new Promise((resolve, reject) => {
      var removeListeners = () => {
        logger.debug('Removing listeners')
        this.frameEmitter.removeListener('frame', onFrame)
        this.frameEmitter.removeListener('error', onError)
      }

            // Wire up listening to wait for response (or error) from PN532
      var onFrame = (frame) => {
        logger.debug('Response received for sendCommand', util.inspect(frame))
                // TODO: If no ACK after 15ms, resend? (page 40 of user guide, UART only)?

        if (frame instanceof AckFrame) {
          logger.info('Command Acknowledged', util.inspect(frame))
        } else if (frame instanceof DataFrame) {
          logger.info('Command Response', util.inspect(frame))
          removeListeners()
          resolve(frame)
        }
      }
      this.frameEmitter.on('frame', onFrame)

      var onError = (error) => {
        logger.error('Error received for sendCommand', error)
        removeListeners()
        reject(error)
      }
      this.frameEmitter.on('error', onError)

            // Send command to PN532
      var dataFrame = new DataFrame(commandBuffer)
      var buffer = dataFrame.toBuffer()
      logger.debug('Sending buffer:', util.inspect(buffer))
      this.hal.write(buffer)
    })
  }

  configureSecureAccessModule () {
    logger.info('Configuring secure access module (SAM)...')

        // TODO: Test IRQ triggered reads

    var timeout = 0x00  // 0x00-0xFF (12.75 seconds).  Only valid for Virtual card mode (SAMCONFIGURATION_MODE_VIRTUAL_CARD)

    var commandBuffer = [
      c.COMMAND_SAMCONFIGURATION,
      c.SAMCONFIGURATION_MODE_NORMAL,
      timeout,
      c.SAMCONFIGURATION_IRQ_ON // Use IRQ pin
    ]
    return this.sendCommand(commandBuffer)
  }

  getFirmwareVersion () {
    logger.info('Getting firmware version...')

    return this.sendCommand([c.COMMAND_GET_FIRMWARE_VERSION])
      .then((frame) => {
        var body = frame.getDataBody()
        return {
          IC: body[0],
          Ver: body[1],
          Rev: body[2],
          Support: body[3]
        }
      })
  }

  getGeneralStatus () {
    logger.info('Getting general status...')

    return this.sendCommand([c.COMMAND_GET_GENERAL_STATUS])
      .then((frame) => {
        var body = frame.getDataBody()
        return body
      })
  }

  scanTag () {
    logger.info('Scanning tag...')

    var maxNumberOfTargets = 0x01
    var baudRate = c.CARD_ISO14443A

    var commandBuffer = [
      c.COMMAND_IN_LIST_PASSIVE_TARGET,
      maxNumberOfTargets,
      baudRate
    ]

    return this.sendCommand(commandBuffer)
      .then((frame) => {
        var body = frame.getDataBody()
        logger.debug('body', util.inspect(body))

        var numberOfTags = body[0]
        if (numberOfTags === 1) {
          var tagNumber = body[1]
          var uidLength = body[5]

          var uid = body.slice(6, 6 + uidLength)
            .toString('hex')
            .match(/.{1,2}/g)
            .join(':')

          return {
            ATQA: body.slice(2, 4), // SENS_RES
            SAK: body[4],           // SEL_RES
            uid: uid,
            tagNumber: tagNumber
          }
        }
      })
  }

  readBlock (options) {
    logger.info('Reading block...')

    options = options || {}

    var tagNumber = options.tagNumber || 0x01
    var blockAddress = options.blockAddress || 0x01

    var commandBuffer = [
      c.COMMAND_IN_DATA_EXCHANGE,
      tagNumber,
      c.MIFARE_COMMAND_READ,
      blockAddress
    ]

    return this.sendCommand(commandBuffer)
      .then((frame) => {
        var body = frame.getDataBody()
        logger.debug('Frame data from block read:', util.inspect(body))

        var status = body[0]

        if (status === 0x13) {
          logger.warn('The data format does not match to the specification.')
        }
        var block = body.slice(1, body.length - 1) // skip status byte and last byte (not part of memory)
        // var unknown = body[body.length];

        return block
      })
  }

  selectApp (options) {
    logger.info('Select...')

    options = options || {}

    var tagNumber = options.tagNumber || 0x01
    var blockAddress = options.blockAddress || 0x01
    var selectApdu = [ 0x00, 0xA4, 0x04, 0x00, 0x0e, 0x32, 0x50, 0x41, 0x59, 0x2e, 0x53, 0x59, 0x53, 0x2e, 0x44, 0x44, 0x46, 0x30, 0x31, 0x00 ]

    var commandBuffer = [
      c.COMMAND_IN_DATA_EXCHANGE,
      tagNumber
    ]

    commandBuffer = commandBuffer.concat(selectApdu)

    return this.sendCommand(commandBuffer)
      .then((frame) => {
        var body = frame.getDataBody()
        logger.debug('Frame data from block read:', util.inspect(body))

        var status = body[0]

        if (status === 0x13) {
          logger.warn('The data format does not match to the specification.')
        }
        var block = body.slice(1, body.length - 1) // skip status byte and last byte (not part of memory)
        // var unknown = body[body.length];

        return block
      })
  }

  parseData (data) {
    let returnData = {
      aid: []
    }
    let jsonData = JSON.parse(JSON.stringify(data))

    for (var i = 0; i < jsonData.data.length; i++) {
      if (i < jsonData.data.length - 1 && jsonData.data[i] === 79 && jsonData.data[i + 1] === 7) {
        console.log('FOUND IT')
        returnData.aid = JSON.parse(JSON.stringify(jsonData.data)).splice(i + 2, i + 9)
      }
    }
    console.log('data information', data.length)
    return data
    // 6f 2d 84 0e 32 50 41 59 2e 53 59 53 2e 44 44 46 30 31 a5 1b bf 0c 18 61 16 4f 07 a0 00 00 00 03 10 10 50 0b 56 69 73 61 20 43 72 65 64 69 74 90 00
  }

  readCard (options) {
    logger.info('Read Card Data...')

    options = options || {}

    var tagNumber = options.tagNumber || 0x01
    var blockAddress = options.blockAddress || 0x01
    var readRecord = [ 0x40, 0x01, 0x00, 0xB2, 0x01, 0x0C, 0x00 ] // InDataExchange
    var readCardInfoVisa = [ 0xA0, 0x00, 0x00, 0x00, 0x03, 0x10 ] // InDataExchange
    var readRecordVisa = [ 0x00, 0xB2, 0x02, 0x0C, 0x00, 0x00 ]
  	var readRecordMC = [ 0x40, 0x01, 0x00, 0xB2, 0x01, 0x14, 0x00, 0x00 ]
  	var readPaylogVisa = [ 0x40, 0x01, 0x00, 0xB2, 0x01, 0x8C, 0x00, 0x00 ]
  	var readPaylogMC = [ 0x40, 0x01, 0x00, 0xB2, 0x01, 0x5C, 0x00, 0x00 ]

    var commandBuffer = [
      c.COMMAND_IN_DATA_EXCHANGE,
      tagNumber
    ]

    commandBuffer = commandBuffer.concat(readRecordVisa)

    return this.sendCommand(commandBuffer)
      .then((frame) => {
        var body = frame.getDataBody()
        logger.debug('Frame data from block read:', util.inspect(body))

        var status = body[0]

        if (status === 0x13) {
          logger.warn('The data format does not match to the specification.')
        }
        var block = body.slice(1, body.length - 1) // skip status byte and last byte (not part of memory)
        // var unknown = body[body.length];

        return block
      })
  }

  readNdefData () {
    logger.info('Reading data...')

    return this.readBlock({blockAddress: 0x04})
      .then((block) => {
        logger.debug('block:', util.inspect(block))

        // Find NDEF TLV (0x03) in block of data - See NFC Forum Type 2 Tag Operation Section 2.4 (TLV Blocks)
        var ndefValueOffset = null
        var ndefLength = null
        var blockOffset = 0

        while (ndefValueOffset === null) {
          logger.debug('blockOffset:', blockOffset, 'block.length:', block.length)
          if (blockOffset >= block.length) {
            throw new Error('Unable to locate NDEF TLV (0x03) byte in block:', block)
          }

          var type = block[blockOffset]       // Type of TLV
          var length = block[blockOffset + 1] // Length of TLV
          logger.debug('blockOffset', blockOffset)
          logger.debug('type', type, 'length', length)

          if (type === c.TAG_MEM_NDEF_TLV) {
            logger.debug('NDEF TLV found')
            ndefLength = length                  // Length proceeds NDEF_TLV type byte
            ndefValueOffset = blockOffset + 2    // Value (NDEF data) proceeds NDEV_TLV length byte
            logger.debug('ndefLength:', ndefLength)
            logger.debug('ndefValueOffset:', ndefValueOffset)
          } else {
                        // Skip TLV (type byte, length byte, plus length of value)
            blockOffset = blockOffset + 2 + length
          }
        }

        var ndefData = block.slice(ndefValueOffset, block.length)
        var additionalBlocks = Math.ceil((ndefValueOffset + ndefLength) / 16) - 1
        logger.debug('Additional blocks needing to retrieve:', additionalBlocks)

                // Sequentially grab each additional 16-byte block (or 4x 4-byte pages) of data, chaining promises
        var self = this
        var allDataPromise = (function retrieveBlock (blockNum) {
          if (blockNum <= additionalBlocks) {
            var blockAddress = 4 * (blockNum + 1)
            logger.debug('Retrieving block:', blockNum, 'at blockAddress:', blockAddress)
            return self.readBlock({blockAddress: blockAddress})
              .then(function (block) {
                blockNum++
                ndefData = Buffer.concat([ndefData, block])
                return retrieveBlock(blockNum)
              })
          }
        })(1)

        return allDataPromise.then(() => ndefData.slice(0, ndefLength))
      }).catch(function (error) {
        logger.error('ERROR:', error)
      })
  }

  writeBlock (block, options) {
    logger.info('Writing block...')

    options = options || {}

    var tagNumber = options.tagNumber || 0x01
    var blockAddress = options.blockAddress || 0x01

    var commandBuffer = [].concat([
      c.COMMAND_IN_DATA_EXCHANGE,
      tagNumber,
      c.MIFARE_COMMAND_WRITE_4,
      blockAddress
    ], block)

    return this.sendCommand(commandBuffer)
      .then((frame) => {
        var body = frame.getDataBody()
        logger.debug('Frame data from block write:', util.inspect(body))

        var status = body[0]

        if (status === 0x13) {
          logger.warn('The data format does not match to the specification.')
        }
        var block = body.slice(1, body.length - 1) // skip status byte and last byte (not part of memory)
                // var unknown = body[body.length];

        return block
      })
  }

  writeNdefData (data) {
    logger.info('Writing data...')

        // Prepend data with NDEF type and length (TLV) and append terminator TLV
    var block = [].concat([
      c.TAG_MEM_NDEF_TLV,
      data.length
    ], data, [
      c.TAG_MEM_TERMINATOR_TLV
    ])

    logger.debug('block:', util.inspect(new Buffer(block)))

    var PAGE_SIZE = 4
    var totalBlocks = Math.ceil(block.length / PAGE_SIZE)

        // Sequentially write each additional 4-byte pages of data, chaining promises
    var self = this
    var allPromises = (function writeBlock (blockNum) {
      if (blockNum < totalBlocks) {
        var blockAddress = 0x04 + blockNum
        var pageData = block.splice(0, PAGE_SIZE)

        if (pageData.length < PAGE_SIZE) {
          pageData.length = PAGE_SIZE // Setting length will make sure NULL TLV (0x00) are written at the end of the page
        }

        logger.debug('Writing block:', blockNum, 'at blockAddress:', blockAddress)
        logger.debug('pageData:', util.inspect(new Buffer(pageData)))
        return self.writeBlock(pageData, {blockAddress: blockAddress})
          .then(function (block) {
            blockNum++
                    // ndefData = Buffer.concat([ndefData, block]);
            return writeBlock(blockNum)
          })
      }
    })(0)

        // return allDataPromise.then(() => ndefData.slice(0, ndefLength));
    return allPromises
  }

    // WIP
  authenticateBlock (uid, options) {
    logger.info('Authenticating block...')

    options = options || {}

    var blockAddress = options.blockAddress || 0x04
    var authType = options.authType || c.MIFARE_COMMAND_AUTH_A
    var authKey = options.authKey || [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    var tagNumber = options.tagNumber || 0x01
    var uidArray = uid.split(':').map(s => Number('0x' + s))

    var commandBuffer = [
      c.COMMAND_IN_DATA_EXCHANGE,
      tagNumber,
      authType,
      blockAddress
    ].concat(authKey).concat(uidArray)

    return this.sendCommand(commandBuffer)
      .then((frame) => {
        var body = frame.getDataBody()
        logger.info('Frame data from mifare classic authenticate', util.inspect(body))

        console.log('body', body)
        return body
      })
  }
}

exports.PN532 = PN532
exports.I2C_ADDRESS = c.I2C_ADDRESS
