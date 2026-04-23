# gateway

CloudFormation template for the CORS proxy that sits between the Even Hub
WebView and note.com.

## Files

- `template.yaml` — full CloudFront distribution + two CloudFront Functions
  (viewer-request & viewer-response). Everything is in one stack so tearing
  it down removes the proxy cleanly.
- `functions/viewer-request.js` / `functions/viewer-response.js` — the same
  JS that's inlined into the template, extracted for easier review / diffs.
  The authoritative copy is `template.yaml`; the files under `functions/`
  are there for readability.

## Prerequisites

- A domain you control (e.g. `note-proxy.example.com`).
- An **ACM certificate in us-east-1** that covers that domain. CloudFront
  reads certs only from us-east-1 regardless of where the stack runs.
- DNS control so you can point an A/AAAA alias at the CloudFront
  distribution after the stack comes up.

## Deploy

```sh
aws cloudformation deploy \
  --stack-name note-proxy \
  --template-file template.yaml \
  --parameter-overrides \
    DomainName=note-proxy.example.com \
    CertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/...
```

The stack itself can live in any region; CloudFront is a global service.

After deploy, get the distribution domain name:

```sh
aws cloudformation describe-stacks --stack-name note-proxy \
  --query 'Stacks[0].Outputs' --output table
```

Then create the DNS alias (Route53 example):

```sh
aws route53 change-resource-record-sets --hosted-zone-id ZXXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "note-proxy.example.com.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "d1234567890.cloudfront.net",
          "EvaluateTargetHealth": false
        }
      }
    }]
  }'
```

`Z2FDTNDATAQYW2` is the fixed CloudFront hosted zone id for A/AAAA aliases.

## Verify

```sh
curl -sI -H 'Origin: https://note-proxy.example.com' \
  'https://note-proxy.example.com/api/v3/searches?context=note&q=test&size=1'
```

You should see `access-control-allow-origin: https://note-proxy.example.com`
and `access-control-allow-credentials: true`.

## Updating just the function code

The functions are inlined in `template.yaml`, so deploying again with
`AutoPublish: true` pushes them straight to LIVE. If you want to edit the
functions separately without a full stack update, grab them with
`aws cloudfront update-function` pointing at the standalone files under
`functions/` — just remember to keep the template copy in sync.

## Gotchas

- `bridge.setLocalStorage` on iOS WKWebView doesn't persist recent writes
  through a force-kill, so the app's auto-login uses stored credentials
  rather than trusting the token alone; this is a client-side concern, not
  something the proxy can help with.
- `request.headers.cookie` is a forbidden field in CloudFront Function
  v2.0 — the viewer-request function must set `request.cookies['name']`
  instead.
- `c.attributes` in viewer-response has **no leading `;`** on the first
  attribute, so `/;\s*Key=/` regexes silently miss the first entry. The
  function uses `.split(';')` + filter which sidesteps this.
