# Required tests

- links a new verified credential
- returns idempotent success for the same canonical user
- returns COLLISION for a different canonical user
- rejects a different completing session
- rejects a different completing user
- rejects expired intent
- rejects consumed intent replay
- rejects provider/client/redirect context mismatch
- verifies atomic consumption under concurrent completion
- verifies domain/application have no adapter imports
