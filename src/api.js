require('dotenv').config();
var Faye = require('faye'),
    logger = require('./logger').logger,
    response = require('./response').response;

exports.api = {
    responseHome: function(req, res, next) {
        var string = 'BSE VR API';
        response.init(req, res, next);
        return response.success(string);
        //return next();
    },
    sendResponse: function(req, res, next) {
        if(response.message !== null) {
            return res.status(response.status).type('json').send(response.message);
        }
        if(response.error_message !== null) {
            return res.status(response.status).type('json').send(response.error_message);
        }
    },
    responseApi: function(req, res, next) {
        let client = new Faye.Client(process.env.VR_URL),
            extender = require('./extender').extender;

        let timeout;
        const time_lapse = .5 * 60 * 1000;

        client.addExtension(extender);
        client.disable('WebSocket');


        let message = req.params.message,
            version = req.params.version,
            uri = '/' + version + '/' + message,
            options = typeSetOptions(req.body),
            api_name = whichApi(message);

        response.init(req, res, next);

        logger.info('---- HTTP Request Received: '+ uri + ' ----');

        extender.init({
            api_name: api_name
        });

        timeout = setTimeout(function() {
            logger.error('---- Request Timed Out: '+ extender.get_channel() + ' ----');

            return response.error('general',500, 'Request Timed Out');
        }, time_lapse);

        client.connect(function () {
            logger.info('---- Connected to VR API ----');

            client.subscribe(extender.get_channel(), messageReceived)
                .then(publish(extender, message, options))
                .catch(error);

        });
    }
};

function publish(extender, message, options) {
    logger.info('---- Subscribed ----');

    var api = extender.api_name,
        location = options.siteID,
        group = extender.get_group(),
        version = extender.get_version(),
        api_key = extender.get_api_key();

    var json = getRequest(extender, message, options, api_key),
        channel = '/' + api + '/' + group + '/' + location,
        messageID = json[version].messageID;

    logger.info('---- Publishing to: ' + channel + ' ----');

    client.publish(channel, json)
        .then(function () {
            logger.info('---- Published ----');
        })
        .catch(function (error) {
            logger.error('---- Publish Error ----');
            return response.error(json[version].messageID, 400, error);
        });

    //return messageID;
}

function error(error) {
    logger.error('---- Caught an Error----');
    logger.log(error);

    clearTimeout(timeout);
    return response.error('general',400, error);
}

function messageReceived(message) {
    logger.info('---- Message Received ----');

    clearTimeout(timeout);

    var version = extender.get_version(),
        messageID = message.data[version].messageID;

    if (message.data[version].successful) {
        //logger.info('---- Successful ----');

        return response.success(message);
    }
    else {
        logger.error('---- Failed ----');

        return response.error(messageID, 400, message);
    }
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

function whichApi(message) {
    switch(message) {
        case 'new_opportunity':
            return 'crm_orders';
        default:
            return 'vr_store';
    }
}

function getRequest(extender, message, options, api_key) {
    logger.info('---- Getting Request ----');
    var json = {
        message: message,
        api_key: api_key
    };

    console.log(message);

    var date = new Date(),
        time = date.getTime(),
        ver = '',
        version = extender.get_version();

    if(options.siteID !== undefined) {
        ver = options.siteID;
    }

    ver += message.replace(/^\//,'') + time.toString();

    json[version] = options;
    json[version].returnChannel = extender.get_channel();
    json[version].messageID = ver;
    json[version].currentTimeStamp =  new Date().toISOString();

    return json;
}

function typeSetOptions(options) {
    let output = {};
    console.log(options);
    for(var index in options) {
        switch(index) {
            case 'siteID':
            case 'transactionType':
            case 'points':
            case 'minimumAvailable':
                output[index] = parseInt(options[index]);
                break;
            case 'totalPayment':
            case 'depositAmount':
            case 'convenienceFee':
                output[index] = parseFloat(options[index]);
                break;
            case 'includeUsed':
            case 'includeNew':
                output[index] = (options[index] === "true");
                break;
            default:
                let re = /([a-zA-Z0-9_]+)\[[0-9]+\]\[([a-zA-Z0-9_]+)\]/,
                    matches = index.match(re);

                if(matches !== null) {
                    if(output[matches[1]] === undefined) {
                        output[matches[1]] = [];
                    }
                    output[matches[1]].push({
                        [matches[2]]: options[index],
                    });
                }
                else {
                    output[index] = options[index];
                }
                break;
        }
    }
    return output;
}