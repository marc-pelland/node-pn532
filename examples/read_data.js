var pn532 = require('../src/pn532')
var SerialPort = require('serialport')

// var serialPort = new SerialPort('COM4', { baudRate: 115200 })
var serialPort = new SerialPort('/dev/tty.usbserial-A501UZN2', { baudRate: 115200 })
var rfid = new pn532.PN532(serialPort)
// var ndef = require('ndef')
var emv = require('node-emv')

console.log('Waiting for rfid ready event...')
rfid.on('ready', () => {
  console.log('Listening for a tag scan...')
  rfid.on('tag', (tag) => {
    console.log('Select App...')
    rfid.selectApp().then((data) => {
      console.log('Tag data:', data)
      var response = rfid.parseApduResponse(data)
      var aip = response.find(0x4f)

      console.log('Authenticating...')
      // rfid.authenticateBlock(aip.getValue()).then(() => {
        console.log(response)
        console.log(aip.getValue())

        rfid.getPDOL().then((cardData) => {
          console.log('card data', cardData.toString('utf8'))
          var response2 = rfid.parseApduResponse(cardData)
          console.log(response2)
          console.log(JSON.stringify(cardData))

          rfid.readCard().then((details) => {
            console.log(details)
            console.log('card details', details.toString('utf8'))
            var response3 = rfid.parseApduResponse(details)
            console.log(response3)
            console.log('child', response3.find('5F20').getValue())


          })
        })
      // })
    })
  })
})
