const Net = require('net')
const express = require('express')
var cors = require('cors')
var bodyParser = require('body-parser')
var ping = require('ping');
var fs = require('fs');
var moment = require('moment');

const tcpServer = new Net.Server()
var clientSocket = null
var TCP_SERVER_PORT = 8100
var API_SERVER_PORT = 8101
const HEARTBEAT_INTERVAL = 5000
const EVENT_RETRY_INTERVAL = 1500
const TCP_CONFIG_JSON_PATH = "/uncanny/sink/client/tcp_config.json"
const TWO_WHEELER_START_COUNTER = 100;

let ENABLE_IOC = true
let ENABLE_NPR = true
const ENABLE_VC = true
const ENABLE_SEND_VC = false

const app = express()
app.use(cors())
app.use(bodyParser.urlencoded({
    extended: true
}))
app.use(bodyParser.json())

const START_DELIMITER = 0x02;
const END_DELIMITER = 0x03;

let heartbeat_list = {}

let lp = null;
let event_timer_list = {}
let ping_counter = 0

console.log("RESTtoTCP: Arguments " + process.argv)

if (process.argv[2] == null || process.argv[3] == null) {
    console.log("RESTtoTCP: Usage TCPServerPort APIServerPort\n")
}

let tcp_config = JSON.parse(fs.readFileSync(TCP_CONFIG_JSON_PATH, 'utf8'));

app.post('/api/tcp', function (req, res) {
    console.log("RESTtoTCP: Received on API:" + JSON.stringify(req.body, null, 4));

    lp = req.body.event.name;

    if (!req.body.extras.device_id || !req.body.extras.camera_ip) {
        res.status(400);
        res.json({})

        console.log("Not sending event as device_id/camera_ip is not set")
        return
    }

    if (req.body.event.vehicle_category.type == 'MOTORCYCLE') {
        req.body.extras.device_id = parseFloat(req.body.extras.device_id) + TWO_WHEELER_START_COUNTER;
    }

    if (event_timer_list[req.body.extras.device_id]) {
        clearTimeout(event_timer_list[req.body.extras.device_id])
    }

    clearDeviceInterval(req.body.extras.device_id)
    startHeartBeatService(req.body.extras.device_id, req.body.extras.camera_ip)

    let data = ("npr " + req.body.extras.device_id + " vnp " + lp).toString('utf8');

    console.log("Data lp to client " + data)

    sendEvent(req.body.extras.device_id, data, res)

    if (req.body.extras.device_id != null && ENABLE_VC) {
        for (var i = 0; i < tcp_config.devices.length; i++) {
            if (tcp_config.devices[i].device_id == req.body.extras.device_id) {
                if (req.body.event.direction.toLowerCase() == 'entry') {
                    tcp_config.devices[i].in_count = tcp_config.devices[i].in_count + 1;
                }

                if (req.body.event.direction.toLowerCase() == 'exit') {
                    tcp_config.devices[i].out_count = tcp_config.devices[i].out_count + 1;
                }

                fs.writeFileSync(TCP_CONFIG_JSON_PATH, getPrettyJSON(tcp_config), 'utf8');
                if (ENABLE_SEND_VC) {
                    console.log("Data vc to client " + data_vc)
                    data_vc = ("ioc " + req.body.extras.device_id + " inc " + tcp_config.devices[i].in_count + " ouc " + tcp_config.devices[i].out_count).toString('utf8');
                    sendVC(data_vc)
                }
            }
        }
    }

})

app.put('/api/servicecontrol', function (req, res) {

    console.log("RESTtoTCP: " + JSON.stringify(req.query));

    if (req.query.ioc == 'false') {
        ENABLE_IOC = false
        console.log("RESTtoTCP: Received request to disable ioc");
    }
    else {
        ENABLE_IOC = true
        console.log("RESTtoTCP: Received request to enable ioc");
    }

    if (req.query.npr == 'false') {
        ENABLE_NPR = false
        console.log("RESTtoTCP: Received request to disable npr");
    }
    else {
        ENABLE_NPR = true
        console.log("RESTtoTCP: Received request to enable npr");
    }

    res.status(200).send('Service status npr ' + ENABLE_NPR + ', ioc ' + ENABLE_IOC)

})

tcpServer.on('connection', function (socket) {

    console.log('RESTtoTCP: New connection ' + socket.remoteAddress + ":" + socket.remotePort)
    socket.setKeepAlive(true)
    clientSocket = socket

    socket.on('data', function (data) {
        console.log("RESTtoTCP: Message from " + moment().format() + " " + socket.remoteAddress + ":" + socket.remotePort + ' msg:' + data.toString('utf8'))

        let req = data.toString('utf8');
        if (req.includes('?')) {
            console.log("Received GET request " + req)

            device_id = req.split(/[ ]/)[1];
            in_count = req.split(/[ ]/)[3];
            out_count = req.split(/[ ]/)[5];

            var count = (req.match(/\?/g) || []).length;

            console.log("RESTtoTCP: " + count);

            if (count == 2) {
                for (var i = 0; i < tcp_config.devices.length; i++) {
                    if (tcp_config.devices[i].device_id == device_id) {
                        data_vc = ("ioc " + device_id + " inc " + tcp_config.devices[i].in_count + " ouc " + tcp_config.devices[i].out_count).toString('utf8');
                        sendVC(data_vc)
                    }
                }
            }
            else {
                if (in_count == '?') {
                    console.log("RESTtoTCP: Querying in count and setting out count " + out_count);
                    for (var i = 0; i < tcp_config.devices.length; i++) {
                        if (tcp_config.devices[i].device_id == device_id) {
                            tcp_config.devices[i].out_count = parseFloat(out_count);
                            fs.writeFileSync(TCP_CONFIG_JSON_PATH, JSON.stringify(tcp_config), 'utf8');
                            data_vc = ("ioc " + device_id + " inc " + tcp_config.devices[i].in_count + " ouc " + tcp_config.devices[i].out_count).toString('utf8');
                            sendVC(data_vc)
                        }
                    }
                }
                else {

                    console.log("RESTtoTCP: Querying out count and setting in count " + in_count);
                    for (var i = 0; i < tcp_config.devices.length; i++) {
                        if (tcp_config.devices[i].device_id == device_id) {
                            tcp_config.devices[i].in_count = parseFloat(in_count);
                            fs.writeFileSync(TCP_CONFIG_JSON_PATH, JSON.stringify(tcp_config), 'utf8');
                            data_vc = ("ioc " + device_id + " inc " + tcp_config.devices[i].in_count + " ouc " + tcp_config.devices[i].out_count).toString('utf8');
                            sendVC(data_vc)
                        }

                    }
                }
            }
        }

        else {

            console.log(moment().format() + " TEST: Received SET request " + req)
            device_id = req.split(/[ ]/)[1];
            in_count = req.split(/[ ]/)[3];
            out_count = req.split(/[ ]/)[5];

            for (var i = 0; i < tcp_config.devices.length; i++) {
                if (tcp_config.devices[i].device_id == device_id) {
                    tcp_config.devices[i].in_count = parseFloat(in_count);
                    tcp_config.devices[i].out_count = parseFloat(out_count);
                    console.log("TEST: Setting in count " + tcp_config.devices[i].in_count + ", out count " + tcp_config.devices[i].out_count + " to device id " + tcp_config.devices[i].device_id);
                    fs.writeFileSync(TCP_CONFIG_JSON_PATH, JSON.stringify(tcp_config), 'utf8');
                    data_vc = ("ioc " + tcp_config.devices[i].device_id + " inc " + tcp_config.devices[i].in_count + " ouc " + tcp_config.devices[i].out_count).toString('utf8');
                    sendVC(data_vc)
                }
            }
        }

    })

    socket.on('end', function () {
        if (clientSocket) {
            clientSocket.destroy()
            clientSocket = null
        }

        clearAllIntervals()

        console.log("RESTtoTCP: Connection end " + socket.remoteAddress + ":" + socket.remotePort)
    })

    socket.on('error', function (err) {
        if (clientSocket) {
            clientSocket.destroy()
            clientSocket = null
        }

        clearAllIntervals()

        console.log("RESTtoTCP: Connection error " + socket.remoteAddress + ":" + socket.remotePort, " err:" + err.code)
    })

    socket.on('close', function (err) {
        if (clientSocket) {
            clientSocket.destroy()
            clientSocket = null
        }

        clearAllIntervals()

        console.log("RESTtoTCP: Connection close " + socket.remoteAddress + ":" + socket.remotePort, " err:" + err.code)
    })

});

tcpServer.listen(TCP_SERVER_PORT, function () {
    console.log("RESTtoTCP: TCP Server Started " + TCP_SERVER_PORT)
})

var apiServer = app.listen(API_SERVER_PORT, function () {
    console.log("RESTtoTCP: API Server Started " + API_SERVER_PORT)
})

process.on('SIGINT', function () {
    apiServer.close(function (apiErr) {
        tcpServer.close(function (tcpErr) {
            process.exit(tcpErr || apiErr ? 1 : 0)
        })
    })
})

function sendEvent(device_id, data, res) {

    if (!ENABLE_NPR) {
        console.log("RESTtoTCP: Not returning npr as it's disabled")
        return
    }

    if (clientSocket && !clientSocket.destroyed) {
        let dataSize = Buffer.byteLength(data)
        let bufferSize = dataSize + 2;
        let buffer = new Buffer(bufferSize)
        buffer.writeUInt8(START_DELIMITER, 0)
        buffer.write(data, 1, dataSize)
        buffer.writeUInt8(END_DELIMITER, bufferSize - 1)
        clientSocket.write(buffer, function (err) {
            if (!res.headersSent) {
                res.json({
                    message: 'Sent Status:' + err
                })
            }
        })
    } else {
        if (!res.headersSent) {
            res.json({
                message: 'Sending event failed. Retrying..'
            })
        }
        event_timer_list[device_id] = setTimeout(function () {
            sendEvent(device_id, data, res)
        }, EVENT_RETRY_INTERVAL);
    }

}

setInterval(recover, 5000);

function recover() {

    for (var i = 0; i < tcp_config.devices.length; i++) {
        if (tcp_config.devices[i].in_count == null) {
            tcp_config.devices[i].in_count = 0
            fs.writeFileSync(TCP_CONFIG_JSON_PATH, JSON.stringify(tcp_config), 'utf8');
            console.log("RESTtoTCP: null in count found and recovered")
            sendError(tcp_config.devices[i].device_id, "ioc", "InvalidFormatErr");
        }
        if (tcp_config.devices[i].out_count == null) {
            tcp_config.devices[i].out_count = 0
            fs.writeFileSync(TCP_CONFIG_JSON_PATH, JSON.stringify(tcp_config), 'utf8');
            console.log("RESTtoTCP: null out count found and recovered")
            sendError(tcp_config.devices[i].device_id, "ioc", "InvalidFormatErr");
        }
    }

}

function sendVC(data) {

    if (!ENABLE_IOC) {
        console.log("RESTtoTCP: Not returning ioc as it's disabled")
        return
    }

    console.log(moment().format() + " RESTtoTCP: Response to client " + data);

    if (clientSocket && !clientSocket.destroyed) {
        let dataSize = Buffer.byteLength(data)
        let bufferSize = dataSize + 2;
        let buffer = new Buffer(bufferSize)
        buffer.writeUInt8(START_DELIMITER, 0)
        buffer.write(data, 1, dataSize)
        buffer.writeUInt8(END_DELIMITER, bufferSize - 1)
        clientSocket.write(buffer, function (err) {
            console.log("Vehicle count info sent to client")
        })
    } else {
        console.log("Unable to send vehicle count info sent to client")
    }

}

function startHeartBeatService(device_id, camera_ip) {

    console.log("Starting heartbeat service for " + device_id)

    var heartbeat_interval_id = setInterval(function () {

        if (clientSocket && !clientSocket.destroyed) {

            let data = ("npr " + device_id + " hbt heartbeat").toString('utf8');
            let dataSize = Buffer.byteLength(data)
            let bufferSize = dataSize + 2;
            let buffer = new Buffer(bufferSize)
            buffer.writeUInt8(START_DELIMITER, 0)
            buffer.write(data, 1, dataSize)
            buffer.writeUInt8(END_DELIMITER, bufferSize - 1)
            clientSocket.write(buffer, function (err) {
                console.log(moment().format() + " Sent heartbeat to client")
            })
        } else {
            console.log(moment().format() + " Sending heartbeat failed...no client")
        }

        pingCamera(device_id, camera_ip);

    }, HEARTBEAT_INTERVAL);

    heartbeat_list[device_id] = heartbeat_interval_id

}

function clearAllIntervals() {

    console.log("Clearing all heartbeat intervals")

    for (var key in heartbeat_list) {
        if (heartbeat_list[key]) {
            clearInterval(heartbeat_list[key])
            heartbeat_list[key] = null
        }
    }

}

function clearDeviceInterval(device_id) {

    console.log("Clearing device interval " + device_id)

    if (!heartbeat_list[device_id]) {
        return
    } else {
        clearInterval(heartbeat_list[device_id])
    }

}

function pingCamera(device_id, camera_ip) {

    ping.sys.probe(camera_ip, function (isAlive) {

        if (!isAlive) {

            ping_counter++;

            if (clientSocket && !clientSocket.destroyed && ping_counter == 10) {

                ping_counter = 0;

                let data = ("npr " + device_id + " err CameraNotReachable").toString('utf8');
                let dataSize = Buffer.byteLength(data)
                let bufferSize = dataSize + 1;
                let buffer = new Buffer(bufferSize)
                buffer.writeUInt8(START_DELIMITER, 0)
                buffer.write(data, 1, dataSize)
                buffer.writeUInt8(END_DELIMITER, bufferSize - 1)
                clientSocket.write(buffer, function (err) {
                    console.log("Sending CameraNotReachable error to client")
                })
            } else {
                ping_counter = 0;
            }

        }
    });
}

function sendError(device_id, type, message) {

    if (clientSocket && !clientSocket.destroyed) {

        let data = (type + " " + device_id + " err " + message).toString('utf8');
        let dataSize = Buffer.byteLength(data)
        let bufferSize = dataSize + 1;
        let buffer = new Buffer(bufferSize)
        buffer.writeUInt8(START_DELIMITER, 0)
        buffer.write(data, 1, dataSize)
        buffer.writeUInt8(END_DELIMITER, bufferSize - 1)
        clientSocket.write(buffer, function (err) {
            console.log("RESTtoTCP: Sending " + message + " error to client")
        })
    }

}

function getPrettyJSON(json) {
    return JSON.stringify(json, null, 4);
}
