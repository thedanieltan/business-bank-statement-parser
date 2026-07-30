# Bank Statement Parser (ANEXT / DBS)

Deterministic, LLM-free parsers that turn ANEXT Bank and DBS Bank
(Singapore) "Account Statement" PDF text into structured transactions.
Written in Google Apps Script (plain ES5-ish JS, no external
dependencies), so it drops straight into any Apps Script project, or
adapts easily to Node/browser JS.

**Every parser file needs `BalanceCheck.gs` alongside it** (in Apps
Script, files in the same project already share one global scope, so this
is automatic there — for Node/browser, concatenate or `require()` it
together with whichever parser you use).

## Why deterministic parsing instead of an LLM

Every rule here is regex/logic written directly against the real column
layout each bank's OCR output produces. No AI is involved in reading the
statement — the same input always produces the same output, which matters
when the output feeds into accounting records.

## What's included

| File | Purpose |
|---|---|
| `src/ParserAnext.gs` | Parser for ANEXT Bank statements |
| `src/ParserDbs.gs` | Parser for DBS Bank statements |
| `src/ParserGeneric.gs` | Conservative fallback for statements that don't match either bank — extracts date/description/balance but flags every row for manual review rather than guessing |
| `src/BalanceCheck.gs` | **Required** by all three parsers above — `validateStatementBalance()`, called automatically at the end of every `parse()` |
| `src/Extract.gs` | Optional: PDF→text via Drive OCR + parser auto-detection. Only needed if you're extracting PDF text inside Apps Script; skip it if you already have your own text extraction |

## Usage

```javascript
const parser = pickParser(statementText); // or call ParserAnext/ParserDbs directly
const statement = parser.parse(statementText);

// statement = {
//   bank: 'ANEXT' | 'DBS' | 'UNKNOWN',
//   accountNumber: '123456789' | null,
//   statementPeriod: { start: Date|null, end: Date|null },
//   openingBalance: number|null,
//   closingBalance: number|null,
//   transactions: [
//     {
//       date: Date,
//       description: string,
//       outgoing: number|null,   // money out
//       incoming: number|null,   // money in
//       balance: number|null,    // running balance after this transaction
//       payerPayee: string,      // best-effort counterparty name, '' if none found
//       parseWarning: string     // present only if something looked off
//     },
//     ...
//   ],
//   balanceCheck: {             // added automatically by parse() -- see BalanceCheck.gs
//     passed: boolean,          // true iff opening + sum(transactions) == closing (and no row breaks continuity)
//     reason: string,           // e.g. "Running balance breaks at transaction 4"
//     expectedClosing: number|null,   // the bank's own stated closing balance
//     calculatedClosing: number|null, // what the parsed transactions add up to
//     variance: number|null           // calculatedClosing - expectedClosing
//   }
// }

if (!statement.balanceCheck.passed) {
  console.warn('Balance tally failed:', statement.balanceCheck.reason || statement.balanceCheck.variance);
  // don't trust this statement's transactions without a manual look
}

statement.transactions.forEach(t => {
  t.type = parser.guessType(t); // optional: 'BANK INTEREST' / 'BANK CHARGES' / ''
});
```

If you're in Apps Script and getting PDFs from Drive, `src/Extract.gs` has
`extractPdfText(file)` (OCR-on-copy via the Drive API advanced service —
enable it under **Services** in the Apps Script editor) and
`pickParser(text)` to auto-select the right parser.

## Detecting your bank / statement format

Each parser has a `detect(text)` that returns true if the text looks like
that bank's statement:

```javascript
if (ParserAnext.detect(text)) { ... }
else if (ParserDbs.detect(text)) { ... }
else { ParserGeneric.parse(text); } // flagged for manual review
```

## Known limitations (by design)

- **PDF text extraction needs a real text layer.** These parsers consume
  already-extracted text (e.g. from Drive's OCR-conversion route, or any
  other text extraction you use). A scanned/photographed statement with no
  text layer needs OCR first; quality varies.
- **Only SGD sections are parsed.** Both banks can print multiple currency
  sections (USD, CNH, EUR, ...) in one statement. Only SGD is isolated and
  parsed out of the box — see `_isolateSGD` in each parser if you need
  another currency.
- **`guessType()` is a hint, not a source of truth.** It only recognizes
  wording the bank itself prints (interest earned, account fees). Anything
  else comes back as `''` — what a transaction is *for* is specific to your
  own business/bookkeeping, which this parser has no way to know.
- **Page-header noise.** Multi-page statements often repeat the account
  holder's own name/address as running header text on every page. Since
  that text is specific to whoever the statement belongs to (not to the
  bank's format), it isn't hardcoded into the `_NOISE` list — if you notice
  your own company name/address leaking into transaction descriptions, add
  it to the `_NOISE` array in the relevant parser file.
- **Layout changes will break this.** Both parsers are written against a
  specific, real statement layout as of 2026. If your bank changes their
  statement format, `detect()` may still match but `parse()` could return
  garbage — always check `statement.balanceCheck.passed` before trusting
  the output; it's computed automatically but it's still your job to look
  at it.

## License

MIT — see `LICENSE`.
