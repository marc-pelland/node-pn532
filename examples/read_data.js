var pn532 = require('../src/pn532')
var SerialPort = require('serialport')

var serialPort = new SerialPort('COM4', { baudRate: 115200 })
// var serialPort = new SerialPort('/dev/tty.usbserial-A501UZN2', { baudRate: 115200 })
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
      let parsedData = rfid.parseData(data)
      console.log(parsedData)
      let results = JSON.parse(JSON.stringify(data)).data
      var id = ''
      for (var i in results) {
        id += results[i].toString(16)
      }

      console.log('card id', id)

      rfid.readCard().then((cardData) => {
        console.log('card data', cardData.toString('utf8'))
        console.log(JSON.stringify(cardData))
        // emv.parse(cardData, function (data) {
        //   if (data != null) {
        //     console.log('other data', data)
        //   }
        // })
      })

      emv.parse(id, (emvData) => {
        if (data != null) {
          console.log('emvData', emvData)
        }
      })
      // var records = ndef.decodeMessage(Array.from(data))
      // console.log(records)
    })
  })
})
