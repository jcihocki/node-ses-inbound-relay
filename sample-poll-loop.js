
(async function() {

    let SesInboundPoller = await require('./ses-inbound-relay').init();

    let smtpConfig = {
        host: 'localhost',
        port: 25
    };

    var poller = new SesInboundPoller("us-east-1", "https://sqs.us-east-1.amazonaws.com/974018730731/johnnyc-lol-inbound-sns-notifications", smtpConfig);

    function handleError() {
        console.log("Encountered an error, backing off.");
        console.log(err, err.stack);
        setTimeout(doPoll, 5000);
    }

    function doPoll() {
        poller.poll(function (err, msgMeta, rawMsg, receiptHandle) {
            if (err) {
                handleError(err);
                return;
            }

            if (msgMeta == null) {
                setTimeout(doPoll, 10);
                return;
            }

            poller.relay(msgMeta, rawMsg, function (err) {
                if (err) {
                    handleError(err);
                    return;
                }

                poller.delete(receiptHandle, function (err) {
                    if (err) {
                        handleError(err);
                        return;
                    }

                    setTimeout(doPoll, 10);
                });
            });
        });
    }

    doPoll();
})();
