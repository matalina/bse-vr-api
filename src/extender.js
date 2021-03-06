require('dotenv').config();
let logger = require('./logger').logger,
    sha256 = require('js-sha256'),
    utf8 = require('utf8');

let mysql      = require('mysql');
let connection = mysql.createConnection({
    host     : process.env.DB_HOST,
    user     : process.env.DB_USER,
    password : process.env.DB_PASSWORD,
    database : process.env.DB_DATABASE
});

let msgHandshake = '/meta/handshake',
    msgConnect = '/meta/connect',
    msgSubscribe = '/meta/subscribe',
    msgApiKeyRequest = 'api_authorize_temporary_key',
    msgApiKeyRevoke = 'api_revoke_temporary_key';

const token = process.env.VR_TOKEN;
const group = process.env.VR_GROUP;
const version = process.env.VR_VERSION;

let response_channel = null,
    api_key = null;

exports.extender = {
    api_name: 'vr_store',
    location: group,
    init: function(data) {
        this.api_name = data['api_name'];

        switch(this.api_name){
            case 'vr_store':
                this.location = group;
                break;
            case 'crm_orders':
                this.location = 'crmChannel';
                break;
        }
    },
    get_channel: function() {
        return response_channel;
    },
    get_group: function() {
        return group;
    },
    get_api_key: function() {
        return api_key;
    },
    get_version: function() {
        return version;
    },
    incoming: function (message, callback) {
        if (message.channel === msgHandshake && message.successful) {
            let obj = JSON.parse(JSON.stringify(message)),
                client_id = (obj.clientId);

                response_channel = "/" + this.api_name + "/" + process.env.VR_GROUP + "/" + client_id + "/response";
                logger.info('response channel: ' + response_channel);
        }

        return callback(message);
    },
    outgoing: function (message, callback) {
        let api_name = this.api_name;
        api_key = token;
        if(message.data !== undefined && message.data.api_key !== undefined) {
            api_key = message.data.api_key;
            delete message.data.api_key;
        }
        else if(message.data !== undefined) {
            delete message.data.api_key;
        }

        let query = connection.query('SELECT * FROM `keys` where token = ?',[api_key], function (error, results, fields) {
            if (error) throw error;

            let key = results[0].key;

            if(key === null) {
                Logger.error('----API Key DB Error----');
                Logger.error(error.toString());

                ee.emit('errorReceived', error);
                return;
            }

            message = outgoingResponse(message, api_key, key, api_name);

            if(message.data !== undefined) {
                //console.log('outgoing', message);
            }
            return callback(message);
        });
    }

};

function outgoingResponse(message, api_key, key, api_name) {
    let salt = generateSalt(),
        type = '';

    let jsonString = JSON.stringify(message);
    let api = null;

    if (message.channel === msgHandshake || message.channel === msgConnect) {
        return message;
    }
    else if (message.channel === msgSubscribe) {
        type = msgSubscribe;
    }
    else {
        type = message.data.message;
    }

    message.ext = {
        "api": api_name,
        "token": api_key,
        "salt": convertToBase64(salt),
        "signature": createSignature(salt, jsonString, key),
        "message": type,
        "data": convertToBase64(jsonString)
    };

    return message;
}

function createSignature(salt, json, key) {
    let utf8Json = utf8.encode(json),
        utf8Key = utf8.encode(key),
        utf8Salt = utf8.encode(salt);

    let encodedJson = sha256(utf8Json),
        encodedJsonPlusKey = sha256(encodedJson + utf8Key),
        encodedJsonPlusKeyPlusSalt = sha256(encodedJsonPlusKey + utf8Salt);

    return encodedJsonPlusKeyPlusSalt;
}

function generateSalt() {
    let charString = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
        salt = '';

    for(let i = 0; i < 16; i++) {
        salt += charString[Math.floor(Math.random() * charString.length)];
    }
    return salt;

}

function convertToBase64(string) {
    let output = '';
    output = new Buffer(string).toString('base64');

    return output;
}