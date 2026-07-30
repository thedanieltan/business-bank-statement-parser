# Business Bank Statement Parser (ANEXT / DBS)

Deterministic, LLM-free parsers that turn ANEXT Bank and DBS Bank
(Singapore) **business/corporate account** "Account Statement" PDF text
into structured transactions. These are written against business account
statement layouts specifically (e.g. DBS's business statement columns,
ANEXT's business account summary format) — not personal account
statements, which may have a different layout these parsers won't
recognize correctly. Written in Google Apps Script (plain ES5-ish JS, no
external dependencies), so it drops straight into any Apps Script
project, or adapts easily to Node/browser JS.

**Every parser file needs `BalanceCheck.gs` alongside it** (in Apps
Script, files in the same project already share one global scope, so this
is automatic there — for Node/browser, concatenate or `require()` it
together with whichever parser you use).

## Getting Started

### Option A: Google Apps Script (recommended if your PDFs live in Google Drive)

1. Go to [script.google.com](https://script.google.com) and create a new
   project (or **Extensions → Apps Script** from a Google Sheet, if you
   eventually want to write output somewhere).
2. Add each file in `src/` as its own script file: **File → New → Script
   file**, name it exactly as shown (e.g. `ParserAnext` — Apps Script
   appends `.gs` automatically), then paste in that file's content.
   Required: `ParserAnext.gs`, `ParserDbs.gs`, `ParserGeneric.gs`,
   `BalanceCheck.gs`. Optional: `Extract.gs` (only if you want the Drive
   OCR helper below).
3. If you're using `extractPdfText()` from `Extract.gs`, enable the Drive
   API advanced service: in the Apps Script editor, click **Services**
   (+ icon) in the left sidebar, add **Drive API**, and save.
4. Write a small driver function to try it end-to-end:
   ```javascript
   function testParseOneStatement() {
     const file = DriveApp.getFilesByName('your-statement.pdf').next();
     const text = extractPdfText(file);   // from Extract.gs
     const parser = pickParser(text);      // from Extract.gs
     const statement = parser.parse(text);
     Logger.log(JSON.stringify(statement, null, 2));
     Logger.log('Balance check passed: ' + statement.balanceCheck.passed);
   }
   ```
5. Run it once from the editor (▶ **Run**) — the first run prompts you to
   authorize Drive/Document access.
6. Check the execution log (**View → Logs**, or Ctrl+Enter) for the parsed
   output.

### Option B: Node.js / plain JS (if you already extract PDF text yourself)

`Extract.gs`'s OCR helpers call Apps-Script-only globals (`DriveApp`,
`Drive`, `DocumentApp`, `Utilities`) and won't run outside Apps Script —
skip that file. Everything else (`ParserAnext.gs`, `ParserDbs.gs`,
`ParserGeneric.gs`, `BalanceCheck.gs`) is plain JS wrapped in a `const X
= { ... }` object literal, so it takes one small step to make it
`require()`-able:

1. Clone the repo:
   ```bash
   git clone https://github.com/thedanieltan/business-bank-statement-parser.git
   ```
2. For each of the 4 required files, rename `.gs` → `.js` and add a single
   line at the end: `module.exports = ParserAnext;` (swap in the matching
   name for each file — `ParserDbs`, `ParserGeneric`, or, for
   `BalanceCheck.gs`, `module.exports = { validateStatementBalance };`).
   `ParserAnext.gs`/`ParserDbs.gs`/`ParserGeneric.gs` each call
   `validateStatementBalance()` internally, so also add
   `const { validateStatementBalance } = require('./BalanceCheck');` near
   the top of those three files.
3. Get your statement's text however you already do (e.g. `pdf-parse`,
   `pdfjs-dist`, or your own OCR pipeline) — these parsers only need a
   plain string, however you got it.
4. Use it:
   ```javascript
   const ParserAnext = require('./src/ParserAnext');
   const ParserDbs = require('./src/ParserDbs');
   const ParserGeneric = require('./src/ParserGeneric');
   const fs = require('fs');

   const statementText = fs.readFileSync('my-statement.txt', 'utf8'); // your extracted text
   const parser = ParserAnext.detect(statementText) ? ParserAnext
                : ParserDbs.detect(statementText)   ? ParserDbs
                : ParserGeneric;
   const statement = parser.parse(statementText);
   console.log(statement.balanceCheck);
   ```

Then see **Usage** below for what the returned `statement` object contains.

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
| `src/BalanceCheck.gs` | **Required** by all three parsers above — `validateStatementBalance()` (called automatically at the end of every `parse()`) and `checkStatementContinuity()` (optional, month-over-month gap check — you call this one yourself) |
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

## Checking continuity across months (optional)

`statement.balanceCheck` only validates one statement against itself. It
can't tell you whether *this* statement picks up where the *last* one left
off — whether a month was skipped, or the wrong account/period got
imported — because this library never sees more than one statement at a
time and has no idea where (or whether) you're keeping a record of past
balances.

`checkStatementContinuity()` (in `BalanceCheck.gs`) fills that gap: you
give it this statement plus whatever closing balance you last recorded
yourself (from any storage you like — a spreadsheet cell, a database row,
`PropertiesService`, a JSON file), and it tells you whether they line up.

```javascript
// You own remembering "last known balance" -- however you already
// persist state. Example using Apps Script's PropertiesService:
const props = PropertiesService.getScriptProperties();
const key = 'lastClosingBalance_' + statement.bank + '_' + statement.accountNumber;
const previousClosingBalance = props.getProperty(key); // null if never set

const continuity = checkStatementContinuity(
  statement,
  previousClosingBalance === null ? null : Number(previousClosingBalance)
);

if (!continuity.ok) {
  console.warn('Continuity check failed:', continuity.reason);
  // e.g. a month is missing between imports -- don't import yet
} else {
  // Safe to import. Record this statement's closing balance for next time.
  props.setProperty(key, String(statement.closingBalance));
}
```

**First month / no previous balance yet:** pass `null` (or `undefined`) as
`previousClosingBalance` — this always passes (`ok: true`) rather than
being treated as a gap. You don't need to detect "is this the first
import" yourself; just pass whatever you have on record, including
nothing.

```javascript
// statement = { openingBalance, ... }
// return = {
//   ok: boolean,
//   reason: string,               // set only when ok is false
//   thisOpening: number|null,      // this statement's own opening balance
//   previousClosing: number|null,  // what you passed in (null if you passed null/undefined)
//   gap: number|null               // thisOpening - previousClosing
// }
```

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
