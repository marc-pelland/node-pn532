var pn532 = require('../src/pn532')
var SerialPort = require('serialport')

// var serialPort = new SerialPort('COM4', { baudRate: 115200 })
var serialPort = new SerialPort('/dev/tty.usbserial-A501UZN2', { baudRate: 115200 })
var rfid = new pn532.PN532(serialPort)
// var ndef = require('ndef')
// var emv = require('node-emv')

console.log('Waiting for rfid ready event...')
rfid.on('ready', () => {
  console.log('Listening for a tag scan...')
  rfid.on('tag', (tag) => {
    console.log('Select App...')
    console.log(tag)
    rfid.selectApp().then((data) => {
      console.log('Tag data:', data)
      if (data.length === 0 || !data) {
        return console.log('Error reading the card')
      }

      var response = rfid.parseApduResponse(data)
      var aip = response.find(0x4f)

      console.log('selected...', aip)

      // console.log('respose from select card', response)
      var aipValue = aip.getValue()

      // mastercard or visa
      var isCreditCard = rfid.isVisa(aipValue) || rfid.isVisa(aipValue)
      console.log('aip is', aipValue)
      console.log('is a valid credit card?', isCreditCard)
      if (!isCreditCard) return false

      var aipBuffer = []
      for (var i = 0; i < aip.getValue().length; i += 2) { aipBuffer.push(parseInt(aip.getValue().substr(i, 2), 16)) }

      rfid.getPDOL({aip: aipBuffer}).then((cardData) => {
        var response2 = rfid.parseApduResponse(cardData)
        console.log(response2)

        rfid.readCard().then((details) => {
          var response3 = rfid.parseApduResponse(details)
          console.log(response3)
          var track2 = response3.getChild()[0].getValue()
          console.log('CARD NUMBER', track2.substr(0, 16), 'EXPIRATION', track2.substr(17, 4))
        })
      })
      // })
    })
  })
})
