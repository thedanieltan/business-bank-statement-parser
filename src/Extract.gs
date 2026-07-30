/**
 * Extract.gs
 * -----------------------------------------------------------------------
 * Optional Google Apps Script helpers for getting text out of a statement
 * PDF and routing it to the right parser. Nothing here is bank- or
 * business-specific -- if you're not running this inside Apps Script, or
 * you already have your own text-extraction pipeline, you can ignore this
 * file entirely and just call ParserAnext/ParserDbs/ParserGeneric's
 * detect()/parse() directly with whatever text you extract yourself.
 *
 * (The balance tally check now lives in BalanceCheck.gs, since parse()
 * calls it automatically -- that one is required, not optional like this
 * file is.)
 * -----------------------------------------------------------------------
 */

/**
 * Returns the first parser (in registration order) whose detect(text)
 * returns true, or ParserGeneric as a last-resort fallback.
 */
function pickParser(text) {
  const parsers = [ParserAnext, ParserDbs]; // add more bank parsers here
  for (let i = 0; i < parsers.length; i++) {
    if (parsers[i].detect(text)) return parsers[i];
  }
  return ParserGeneric;
}

/**
 * Extracts text from a PDF using Drive's OCR-on-copy conversion. Works well
 * for statements with a real text layer; degrades badly on scanned/
 * image-only PDFs -- that's a known limitation of this approach, not
 * something this function tries to work around.
 *
 * Requires the "Drive API" advanced service to be enabled in the Apps
 * Script project (Editor -> Services -> Drive API), since DriveApp alone
 * has no OCR-conversion path.
 */
function extractPdfText(file) {
  const blob = file.getBlob();
  const resource = {
    title: file.getName() + ' (OCR temp)',
    // This mimeType describes the UPLOADED content (a PDF), NOT the desired
    // output. Setting it to GOOGLE_DOCS makes Drive think we're inserting a
    // Doc and reject OCR ("OCR is not supported for files of type
    // application/vnd.google-apps.document"). With ocr:true, Drive OCRs the
    // PDF and returns a Google Doc automatically, which we open below.
    mimeType: blob.getContentType()
  };
  const options = { ocr: true, ocrLanguage: 'en' };

  const tempFile = insertWithOcrRetry(resource, blob, options);
  const doc = DocumentApp.openById(tempFile.id);
  const text = doc.getBody().getText();

  // Clean up the temporary OCR'd Doc immediately.
  DriveApp.getFileById(tempFile.id).setTrashed(true);

  return text;
}

/**
 * Drive.Files.insert with OCR, retrying on Drive's per-user OCR rate limit
 * using exponential backoff (2s, 4s, 8s, 16s, 32s). Non-rate-limit errors
 * are rethrown immediately.
 */
function insertWithOcrRetry(resource, blob, options) {
  const maxAttempts = 6;
  let delayMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return Drive.Files.insert(resource, blob, options);
    } catch (err) {
      const msg = String((err && err.message) || err).toLowerCase();
      const isRateLimit = msg.indexOf('rate limit') !== -1 ||
                          msg.indexOf('ratelimitexceeded') !== -1 ||
                          msg.indexOf('userratelimitexceeded') !== -1;
      if (!isRateLimit || attempt === maxAttempts) throw err;
      Utilities.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 32000);
    }
  }
}
