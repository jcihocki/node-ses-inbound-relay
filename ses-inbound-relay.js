const AWS = require('aws-sdk');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PersistentCache = require('node-persist');


module.exports = {
    init: async function() {
        await PersistentCache.init({ttl: 3600 * 1000 /* 1 hour */, dir: "/tmp/ses-inbound-relay-cache"});

        return SesInboundRelay;
    }
}

class SesInboundRelay {
    constructor(region, sqsQueueUrl, smtpConfig) {

        AWS.config.update({ region: region });
        this.sqsClient = new AWS.SQS();
        this.s3Client = new AWS.S3({apiVersion: '2006-03-01'});
        this.sqsQueueUrl = sqsQueueUrl;

        if (typeof(smtpConfig) != "undefined") {
            this.smtpRelayTransport = nodemailer.createTransport(smtpConfig);
        }
        else {
            this.smtpRelayTransport = null;
        }

        this.kms = new AWS.KMS();

        this.reqParams =  {
            AttributeNames: [
                "SentTimestamp"
            ],
            MaxNumberOfMessages: 10,
            MessageAttributeNames: [
                "All"
            ],
            QueueUrl: sqsQueueUrl,
            WaitTimeSeconds: 20
        };
    }

    poll(callback) {
        let s3Client = this.s3Client;
        let kms = this.kms;
        this.sqsClient.receiveMessage(this.reqParams, function(err, data) {
            if (err) {
                callback(err, null, null, null);
            }
            else {
                if (typeof(data.Messages) == "undefined") {
                    callback(undefined, null, null, null);
                    return;
                }
                data.Messages.forEach(function(sqsMsg, i) {
                    let details = JSON.parse(sqsMsg.Body);
                    let msg = JSON.parse(details.Message);
                    let receiptHandle = sqsMsg.ReceiptHandle;
                    if (msg.notificationType == "Received") {
                        let s3Info = msg.receipt.action;
                        let params = {Bucket: s3Info.bucketName, Key: s3Info.objectKey};
                        s3Client.getObject(params, function (err, obj) {

                            if (err) {
                                callback(err, null, null, null);
                                return;
                            }

                            if ((obj.Metadata || {})['x-amz-key-v2']) {

                                decrypt(kms, obj, function (err, data) {
                                    if (err) {
                                        callback(err, null, null, null);
                                        return;
                                    }
                                    callback(undefined, msg, data, receiptHandle);
                                })
                            }
                            else {
                                callback(undefined, msg, obj, receiptHandle);
                            }
                        });
                    }
                });
            }
        });
    }

    async relay(sqsMsg, rawMimeMsg, callback) {

        if (this.smtpRelayTransport == null) {
            throw "You must supply smtpConfig when creating poller to use relay()";
        }
        let sentAlreadyInfo = await PersistentCache.getItem(sqsMsg.mail.messageId);
        if (sentAlreadyInfo != undefined) {
            callback(undefined, info);
            return;
        }

        let message = {
            envelope: {
                from: sqsMsg.mail.source,
                to: sqsMsg.receipt.recipients
            },
            raw: rawMimeMsg
        };
        this.smtpRelayTransport.sendMail(message, async function(err, info) {
            if (err) {
                callback(err);
                return;
            }
            else {
                await PersistentCache.setItem(sqsMsg.mail.messageId, info);
                callback(err, info);
            }
        });
    }

    delete(receiptHandle, callback) {
        var params = {
            QueueUrl: this.sqsQueueUrl,
            ReceiptHandle: receiptHandle
        };

        this.sqsClient.deleteMessage(params, callback);
    }
};


/**
 * Decrypt s3 file data (source: https://github.com/gilt/node-s3-encryption-client/issues/3#issuecomment-333648943)
 * @param  {object}   objectData result of s3 get call
 * @param  {Function} callback   function(err, data) returns error or decrypted data
 */
function decrypt(kms, objectData, callback) {
    let metadata = objectData.Metadata || {};
    let kmsKeyBase64 = metadata['x-amz-key-v2'];
    let iv = metadata['x-amz-iv'];
    let tagLen = (metadata['x-amz-tag-len'] || 0)/8;
    let algo = metadata['x-amz-cek-alg'];
    let encryptionContext = JSON.parse(metadata['x-amz-matdesc']);

    switch (algo) {
        case 'AES/GCM/NoPadding':
            algo = 'aes-256-gcm';
            break;
        case 'AES/CBC/PKCS5Padding':
            algo = 'aes-256-cbc';
            break;
        default:
            callback(new Error('Unsupported algorithm: ' + algo), null);
            return;
    }

    if (typeof (kmsKeyBase64) === 'undefined') {
        callback(new Error('Missing key in metadata'), null);
        return;
    }

    let kmsKeyBuffer = new Buffer(kmsKeyBase64, 'base64');
    kms.decrypt({
        CiphertextBlob: kmsKeyBuffer,
        EncryptionContext: encryptionContext
    }, function(err, kmsData) {
        if (err) {
            callback(err, null);
        } else {
            let data = objectData.Body.slice(0,-tagLen);

            let decipher = crypto.createDecipheriv(algo,
                kmsData.Plaintext,
                new Buffer(iv, 'base64'));

            if (tagLen !== 0) {
                console.log(3);
                let tag = objectData.Body.slice(-tagLen);
                decipher.setAuthTag(tag);
            }

            let dec = decipher.update(data, 'binary', 'utf8');
            dec += decipher.final('utf8');

            callback(null, dec);
        }
    });
}
