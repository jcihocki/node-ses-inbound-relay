
# Node JS relay consumer for inbound mail to Amazon Simple Email Service 

Amazon Web Services' Simple Email Service (SES) supports inbound email processing, which is quite useful. It offers
DKIM verification, can require STARTTLS, and does spam filtering. When received, email can trigger lambdas, publish notifications to SNS topics, and offers numerous automation opportunities. Plus, receiving inbound email can be beneficial to your sender reputation.
However, it does not natively support relaying inbound mail to yourcompany.com to a "final" destination like gsuite or exchange
after processing, so many customers are forced to create separate domains, or subdomains, and forwarding email they want processed by SES to those other domains.

💩

## How it works

```
📧📧📧📧📧📧 
⬇️
SES ➡️ msg body to S3
⬇️
SNS topic notification
⬇️
Subscribed SQS queue message
⬇️
long poll for queue messages
⬇️
SQS message delivered ⬅️ msg retrieved from S3
⬇️
nodemailer sends to smtp MTA (postfix)
⬇️
postfix routes to gsuite/exchange/local mailbox depending on how it's configured.

```
## Words of caution

This is by no means intended to be its own "mail transport agent". It uses [nodemailer](https://nodemailer.com/about/) and does not extend it functionally. You should * always * relay mail to an actual, mature mail transport agent like postfix, which can then ferry messages to the "real" smtp destination in a sane way.

The initial version of this processes message bodies in memory. I can't predict what might happen if messages come in that are extremely large. The first and fairly straightforward improvement would be to manage messages on the file system instead.

The relay doesn't bother to delete the messages from S3, it's easy enough to set them to expire after 24 hours or whatever. Having them may be helpful for debugging any issues that come up. 

It's supposedly possible for SQS to deliver messages multiple times. In this case the relay makes only a very casual and naive effort not to send the same email twice based on its message id. My guess is that your MTA (postfix) and/or the final destination would clean up duplicate messages for you, but it's something to keep in mind especially if you intend to parallelize relay processing for high throughput domains. 

### Configuring SES

To work with this relay, create an SNS topic that will be notified when email comes in, and at least one SQS queue that subscribes to that topic. Then create an S3 bucket to store mail if you don't want to use an existing bucket. Finally, create an inbound SES rule set that will save messages to S3 and publish to the topic. 

You'll need to run the relay as an IAM user that has access to: read and delete SQS messages in the queue, read keys from the S3 bucket, and also read and decrypt using the KMS key if you turned encryption on in the rule set. 

### Installing

[https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html](Configure your AWS IAM user on the host that will be running node)

Perhaps I'll package this as a npm module after it's been performing acceptably in production for a while, but for now...

```
git clone https://github.com/jcihocki/node-ses-inbound-relay.git
cd node-ses-inbound-relay
npm install
vi sample-poll-loop.js # Configure smtp target and queue url, etc.
node ./sample-poll-loop.js
```

Callbacks are provided before each processing step so you can decide whether just to relay it, or skip it, or add additionally message processing functionality, like posting back to a web server, queueing an analytics event, etc. 

## Built With

* [nodemailer](https://nodemailer.com/about/) - mail server connectivity
* [AWS SDK](https://aws.amazon.com/sdk-for-node-js/) - AWS client
* decryption routine shamelessly copied from [this](https://github.com/gilt/node-s3-encryption-client/issues/3#issuecomment-333648943) helpful post by [Garth Goodson](https://github.com/garthgoodson)


## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details


