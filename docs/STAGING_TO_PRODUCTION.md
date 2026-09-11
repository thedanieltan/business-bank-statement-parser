# Staging-to-production setup

Use this repository as parser source and fixture coverage, not as a store for customer configuration or statement data.

## Staging

1. Create separate staging copies of the Apps Script project and reconciliation workbook.
2. Configure only staging spreadsheet, folder, email, and bot destinations.
3. Put credentials in the staging Apps Script project's Script Properties. Never place values in source files, tests, logs, issues, or commits.
4. Start with triggers disabled.
5. Run `npm test` and add synthetic regression fixtures for every new statement layout.
6. Confirm that imports fail closed for zero-value transactions, printed-amount mismatches, running-balance breaks, row-count mismatches, closing-balance variance, and month-to-month discontinuity.
7. Exercise correction proposal, confirmation, rejection, expiry, sender mismatch, fingerprint mismatch, and cleanup behavior using synthetic rows.

## Production promotion

1. Pull production and reconcile any drift before changing it.
2. Promote the exact tested parser and validator revision.
3. Configure production identifiers and secrets outside the public repository.
4. Enable triggers only after a controlled manual run succeeds.
5. Read back the imported rows, formulas, audit events, and operational state.
6. Remove temporary fixtures, flags, test deployments, and test-only functions.
7. Record implementation, integration, deployment, live acceptance, and operational status separately.

## Reusable-template release gate

- Only generic names and synthetic transactions are present.
- No account numbers, entity names, email addresses, folder IDs, spreadsheet IDs, deployment IDs, access tokens, bot tokens, chat IDs, or production audit records are included.
- Setup documents name required properties but never contain their values.
- The template is independently testable with `npm test`.
- Staging and production are separate projects, workbooks, credentials, bots, triggers, and audit records.
