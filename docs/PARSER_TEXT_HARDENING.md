# DBS text-boundary hardening

Objective: preserve transaction details while excluding repeated page furniture,
check independently printed gross totals when available, and retain existing
DBS/ANEXT interfaces. Categorization remains the caller's responsibility.

Scope:

- DBS table/page boundaries, including continuations after a complete repeated
  table heading and stopping at the printed summary or carried-forward balance.
- DBS running-balance differences rounded to cents.
- Optional printed withdrawal/deposit summary validation in the shared validator.
- Synthetic regressions for text noise, gross-total mismatches, legacy DBS,
  both ANEXT formats, routing, continuity, and optional categorization hints.

Excluded: account-holder configuration, business rules, payee aliases, category
allocation, invoices, ledgers, email/bot integrations, OCR providers or retry
changes, real statements, real transaction details and identifiers.

Compatibility: `detect(text)`, `parse(text)`, `guessType(transaction)` and the
existing transaction fields are unchanged. Legacy DBS extracts without an
independently identifiable summary keep their existing output shape. A proven
DBS gross summary adds `statementTotals: { debit, credit }`; it does not invent
an interest subtotal. ANEXT source and both complete output contracts remain
unchanged. A present malformed or duplicate summary with recognized columns
fails validation rather than bypassing the check.

Verification: `npm test`, JavaScript syntax checks, diff review and a local
publication privacy scan. Test data is handwritten and fictional. No private
workspace, account access or document is required to run the public suite.

Publication state: implementation and verification recorded in the pull request;
publishing parser source does not deploy it into any consuming application.
