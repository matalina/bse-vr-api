//require('dotenv').config();
const winston = require('winston');
require('winston-daily-rotate-file');
const axios = require('axios');

var transport = new (winston.transports.DailyRotateFile)({
    filename: 'logs/.log',
    level: 'debug',
    datePattern: 'yyyy-MM-dd',
    prepend: true,
    maxDays: 90
});

const logger = new (winston.Logger)({
    transports: [
        transport
    ],
    exitOnError: false
});

var sha256 = require('js-sha256'),
    utf8 = require('utf8'),
    Faye = require('faye'),
    //restify = require('restify'),
    //express = require('express'),
    //cors = require('cors'),
    events = require('events'),
    moment = require('moment'),
    //firenze = require('firenze'),
    //MysqlAdapter = require('firenze-adapter-mysql'),
    os = require('os'),
    express = require('express'),
    cors = require('cors');

var msgHandshake = '/meta/handshake',
    msgConnect = '/meta/connect',
    msgSubscribe = '/meta/subscribe',
    msgApiKeyRequest = 'api_authorize_temporary_key',
    msgApiKeyRevoke = 'api_revoke_temporary_key';

var token = process.env.VR_TOKEN,
    group = process.env.VR_GROUP,
    version = '';

var EventEmitter = events.EventEmitter,
    ee = new EventEmitter(),
    waitTime = 0.5 * 60 * 1000;

var channels = {
    vr_store: {
        response: '',
        publish: '/vr_store/' + group + '/'
    },
    crm_orders: {
        response: '',
        publish: '/crm_orders/' + group + '/'
    }
};

/*var Database = firenze.Database,
    db = new Database({
        adapter: MysqlAdapter,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    });

var Keys = db.createCollection( {
        table: 'keys',
        alias: 'Key'
    }),
    keys = new Keys();*/

var mysql      = require('mysql');
var connection = mysql.createConnection({
    host     : process.env.DB_HOST,
    user     : process.env.DB_USER,
    password : process.env.DB_PASSWORD,
    database : process.env.DB_DATABASE
});

var client = new Faye.Client(process.env.VR_URL);

function pushToSlack(message) {
    var url = 'https://hooks.slack.com/services/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';

    axios({
        method: 'post',
        url: url,
        headers: {
            'Content-type': 'application/json'
        },
        data: {
            text: message
        }
    });
}

function getIPAddress() {
    var ifaces = os.networkInterfaces();
    var ip;

    Object.keys(ifaces).forEach(function (ifname) {
        var alias = 0;

        ifaces[ifname].forEach(function (iface) {
            if ('IPv4' !== iface.family || iface.internal !== false) {
                // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
                return;
            }

            if (alias >= 1) {
                // this single interface has multiple ipv4 addresses
                //console.log(ifname + ':' + alias, iface.address);
                ip = iface.address;
            } else {
                // this interface has only one ipv4 adress
                //console.log(ifname, iface.address);
                ip = iface.address;
            }
            ++alias;
        });
    });

    return ip.toString();
}

function convertToBase64(string) {
    var output = '';
    output = new Buffer(string).toString('base64');

    return output;
}

function getRequest(message, options, api_key) {
    var json = {
        message: message,
        api_key: api_key
    };

    var date = new Date(),
        time = date.getTime(),
        ver = '';

    if(options.siteID !== undefined) {
        ver = options.siteID;
    }

    ver += message.replace(/^\//,'') + time.toString();

    var api = whichApi(message);

    json[version] = options;
    json[version].returnChannel = channels[api].response;
    json[version].messageID = ver;
    json[version].currentTimeStamp =  new Date().toISOString();

    //pushToSlack(JSON.stringify(json));

    return json;
}

function whichApi(message) {
    var pattern = new RegExp('crm_orders');

    if(pattern.exec(message)) {
        message = 'crm_orders';
    }

    switch(message) {
        case 'new_opportunity': case 'crm_orders':
        return 'crm_orders';
        default:
            return 'vr_store';
    }
}

function whichLocation(message, options) {
    switch(message) {
        case 'new_opportunity':
            return 'crmChannel';
        default:
            return options.siteID;
    }
}

function publishToApi(message, options, api_key) {
    var api = whichApi(message);
    var location = whichLocation(message, options);

    if(message === msgApiKeyRequest) {
        //options['expires'] = moment().add(1,'hours').format();
    }
    if(message === msgApiKeyRevoke) {
        options['temp_token'] = api_key;
    }

    var json = getRequest(message, options, api_key),
        channel = channels[api].publish + location,
        messageID = json[version].messageID;

    console.log('----Publishing \''+ messageID + '\' to: ' + channel + '----');
    logger.info('----Publishing \''+ messageID + '\' to: ' + channel + '----');

    pushToSlack(JSON.stringify(json));

    client.publish(channel, json)
        .then(function () {
            console.log('----Published----');
            logger.info('----Published----');
        })
        .catch(function (error) {
            console.log('----Publish Error----');
            console.log('error:', error);
            logger.error('----Publish Error----');
            logger.error(error.toString());

            var error = {
                status: error.code,
                message: {
                    messageID: messageID,
                    error: '*' + error.toString() + '*  _\'' + message + '\'_ to: ' + channel,
                    successful: false
                }
            };

            ee.emit('errorReceived', error);
        });

    return messageID;

}

function createSignature(salt, json, key) {
    var utf8Json = utf8.encode(json),
        utf8Key = utf8.encode(key),
        utf8Salt = utf8.encode(salt);

    var encodedJson = sha256(utf8Json),
        encodedJsonPlusKey = sha256(encodedJson + utf8Key),
        encodedJsonPlusKeyPlusSalt = sha256(encodedJsonPlusKey + utf8Salt);

    return encodedJsonPlusKeyPlusSalt;
}

function generateSalt() {
    var charString = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
        salt = '';

    for(var i = 0; i < 16; i++) {
        salt += charString[Math.floor(Math.random() * charString.length)];
    }
    return salt;

}

function outgoingResponse(message, api_key, key) {
    var salt = generateSalt(),
        type = '';

    var jsonString = JSON.stringify(message);
    var api = null;

    if (message.channel === msgHandshake || message.channel === msgConnect) {
        return message;
    }
    else if (message.channel === msgSubscribe) {
        type = msgSubscribe;
        api = whichApi(message.subscription);
    }
    else {
        type = message.data.message;
        api = whichApi(type);
    }

    message.ext = {
        "api": api,
        "token": api_key,
        "salt": convertToBase64(salt),
        "signature": createSignature(salt, jsonString, key),
        "message": type,
        "data": convertToBase64(jsonString)
    };

    return message;
}

var Extender = {
    incoming: function (message, callback) {
        if (message.channel === msgHandshake && message.successful) {
            var obj = JSON.parse(JSON.stringify(message)),
                client_id = (obj.clientId);

            for(var index in channels) {
                channels[index].response = "/" + index + "/" + group + "/" + client_id + "/response";

                console.log(index + ' response channel: ', channels[index].response);
                logger.info(index + ' response channel: ' + channels[index].response);
                pushToSlack(index + ' response channel: ' + channels[index].response);
            }
        }
        return callback(message);
    },
    outgoing: function (message, callback) {
        if(message.data !== undefined && message.data.api_key !== undefined) {
            var api_key = message.data.api_key;
            delete message.data.api_key;
        }
        else if(message.data !== undefined) {
            delete message.data.api_key;
            api_key = token;
        }
        else {
            api_key = token;
        }

        connection.query('SELECT * FROM `keys` where token = \'' + api_key + '\'', function (error, results, fields) {
            if (error) throw error;

            var key = results[0].key;

            if(key === null) {
                console.log('----API Key DB Error----');
                console.log('error:', error);
                logger.error('----API Key DB Error----');
                logger.error(error.toString());

                ee.emit('errorReceived', error);
                return;
            }

            message = outgoingResponse(message, api_key, key);
            return callback(message);
        });
    }
};

client.addExtension(Extender);
client.disable('WebSocket');

function responseHome(req, res, next) {
    res.send(200,'BSE VersiRent API ');
    return next();
}

function responseApi(req, res, next) {
    var message = req.params.message,
        api_key = null;

    if(message === msgApiKeyRequest || message === msgApiKeyRevoke) {
        api_key = token;
    }
    else {
        api_key = req.headers['x-api-key'];
    }

    version = req.params.version;

    var options = {};

    if(req.headers['x-store-number'] !== undefined || req.headers['x-store-number'] !== null) {
        options['siteID'] = req.headers['x-store-number']
    }
    else {
        console.log('----Error: '+ messageID +'----');
        logger.error('----Error: '+ messageID +'----');
        var error = {
            status: 400,
            message: {
                error: 'Store Undefined',
                successful: false
            }
        };
        pushToSlack(error.message.error);
        res.json(error.status,error.message);
        return next();
    }

    var temp = req.body;

    if(typeof req.body === 'string') {
        temp = req.params;
    }

    // Collect Deposit needs to be looked at
    for(var index in temp ) {
        if(index === 'siteID') {
            options[index] = parseInt(temp[index]);
        }
        else if(index === 'transactionType') {
            options[index] = parseInt(temp[index]);
        }
        else if(index === 'points') {
            options[index] = parseInt(temp[index]);
        }
        else if(index === 'totalPayment') {
            options[index] = parseFloat(temp[index]);
        }
        else if(index === 'minimumAvailable') {
            options[index] = parseInt(temp[index]);
        }
        else if(index === 'includeUsed') {
            options[index] = (temp[index] === "true");
        }
        else if(index === 'includeNew') {
            options[index] = (temp[index] === "true");
        }
        else if(index === 'depositAmount') {
            options[index] = parseFloat(temp[index]);
        }
        else if(index === 'convenienceFee') {
            options[index] = parseFloat(temp[index]);
        }
        else {
            options[index] = temp[index];
        }
    }

    var messageID = publishToApi(message, options, api_key);

    var timeout = setTimeout(function() {
        console.log('----Timeout: '+ messageID +'----');
        logger.error('----Timeout: '+ messageID +'----');
        var error = {
            status: 408,
            message: {
                error: 'Timeout Detected.  Probable cause: Return data set too large.',
                successful: false
            }
        };
        pushToSlack(error.message.error);
        res.json(error.status,error.message);
        return next();
    }, waitTime);

    ee.on('messageReceived', function(message) {
        console.log('response: ', message);
        if(message.data.message === msgApiKeyRequest) {
            keys[message.data.temp_token] = message.data.private_key;
            delete message.data.private_key;
        }

        if(message.data[version].messageID === messageID) {
            clearTimeout(timeout);
            res.json(200, message);
            return next();
        }
    });

    ee.on('errorReceived', function(message) {
        console.log(message);
        //if(message.message.messageID === messageID) {
            clearTimeout(timeout);
            pushToSlack(message.message.error);
            res.json(message.status, message.message);
            return next();
        //}
    });
}

var server = express();

server.use(cors());

server.options('*', cors());

server.post('/:version/:message', responseApi);
server.get('/', responseHome);


var ip = getIPAddress();

server.listen({
    port: 3030,
    host: ip
}, function() {
    client.connect(function () {
        for (var index in channels) {
            client.subscribe(channels[index].response, function (message) {
                var messageID = message.data[version].messageID;

                if (message.data[version].successful) {
                    console.log('----Message Received: ' + messageID + '----');
                    ee.emit('messageReceived', message);
                }
                else {
                    var error_message = message.data[version].errorDescription;

                    if (error_message === undefined) {
                        error_message = 'No error message defined.';
                    }

                    console.log('----Message Error: ' + error_message + '----');
                    console.log('message:', message);

                    var error = {
                        status: 400,
                        message: {
                            messageID: messageID,
                            successful: false,
                            message: error_message
                        }
                    };

                    pushToSlack(error_message);
                    ee.emit('errorReceived', error);
                }
            })
                .then(function () {
                    console.log('----Subscribed----');
                    logger.info('----Subscribed----');
                })
                .catch(function (error) {
                    console.log('----Subscription error----');
                    console.log('error:', error);
                    logger.error('----Subscription error----');
                    logger.error(error.toString());
                    pushToSlack(error.toString());

                    var n_error = {
                        status: 401,
                        message: {
                            successful: false,
                            message: error_message
                        }
                    };

                    ee.emit('errorReceived', n_error);
                });
        }
    });
}
);
