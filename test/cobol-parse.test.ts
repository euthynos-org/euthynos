import { describe, expect, it } from 'vitest';
import { parseCobolSource } from '../src/parse/cobol.js';

// COBOL is a deterministic line parser — no tree-sitter grammar, so no
// loadLanguages() needed.

const PROGRAM = `      ******************************************************************
      * Sample payment program
      ******************************************************************
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAYPROG.
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-TOTAL      PIC 9(5).
       LINKAGE SECTION.
       01  LK-AMOUNT     PIC 9(5).
       01  LK-RESULT     PIC 9(5).
       PROCEDURE DIVISION USING LK-AMOUNT LK-RESULT.
       MAIN-PARA.
           PERFORM COMPUTE-FEE.
           CALL 'TAXPROG' USING WS-TOTAL.
           GOBACK.
       COMPUTE-FEE.
           MOVE LK-AMOUNT TO WS-TOTAL.
           ADD 10 TO WS-TOTAL.
           MOVE WS-TOTAL TO LK-RESULT.
`;

describe('cobol: program structure → ParsedFile', () => {
  it('extracts PROGRAM-ID as the exported surface with USING params', () => {
    const pf = parseCobolSource('payprog.cob', 'payment', false, PROGRAM);
    expect(pf.exports).toHaveLength(1);
    const ex = pf.exports[0]!;
    expect(ex.name).toBe('PAYPROG');
    expect(ex.kind).toBe('function');
    expect(ex.totalParams).toBe(2); // LK-AMOUNT, LK-RESULT
  });

  it('extracts paragraphs as internal functions', () => {
    const pf = parseCobolSource('payprog.cob', 'payment', false, PROGRAM);
    const names = pf.functions.map((f) => f.name);
    expect(names).toContain('MAIN-PARA');
    expect(names).toContain('COMPUTE-FEE');
    // paragraphs are internal; PAYPROG (the program) is the exported one
    expect(pf.internalFunctions).toBe(2);
    const main = pf.functions.find((f) => f.name === 'MAIN-PARA')!;
    expect(main.exported).toBe(false);
  });

  it('captures PERFORM as an intra-program call edge', () => {
    const pf = parseCobolSource('payprog.cob', 'payment', false, PROGRAM);
    const main = pf.functions.find((f) => f.name === 'MAIN-PARA')!;
    expect(main.calls).toContain('COMPUTE-FEE');
  });

  it('captures CALL as a cross-program call edge', () => {
    const pf = parseCobolSource('payprog.cob', 'payment', false, PROGRAM);
    const main = pf.functions.find((f) => f.name === 'MAIN-PARA')!;
    expect(main.calls).toContain('TAXPROG');
  });

  it('resolves PERFORM ... THRU to both endpoints', () => {
    const src = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. T2.
       PROCEDURE DIVISION.
       A-PARA.
           PERFORM B-PARA THRU C-PARA.
       B-PARA.
           DISPLAY 'B'.
       C-PARA.
           DISPLAY 'C'.
`;
    const pf = parseCobolSource('t2.cbl', 'm', false, src);
    const a = pf.functions.find((f) => f.name === 'A-PARA')!;
    expect(a.calls).toContain('B-PARA');
    expect(a.calls).toContain('C-PARA');
  });

  it('captures COPY as an import', () => {
    const src = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. T3.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTREC.
       PROCEDURE DIVISION.
       MAIN.
           DISPLAY 'HI'.
`;
    const pf = parseCobolSource('t3.cob', 'm', false, src);
    expect(pf.imports.map((i) => i.specifier)).toContain('CUSTREC');
  });

  it('detects clone paragraphs via a rename-insensitive body hash', () => {
    const src = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. T4.
       PROCEDURE DIVISION.
       FIRST-PARA.
           MOVE WS-A TO WS-B.
           ADD 1 TO WS-B.
       SECOND-PARA.
           MOVE WS-X TO WS-Y.
           ADD 1 TO WS-Y.
`;
    const pf = parseCobolSource('t4.cob', 'm', false, src);
    const first = pf.functions.find((f) => f.name === 'FIRST-PARA')!;
    const second = pf.functions.find((f) => f.name === 'SECOND-PARA')!;
    // same structure, different data-names → equal hash (clone)
    expect(first.bodyHash).toBe(second.bodyHash);
    expect(first.bodyTokens).toBeGreaterThan(0);
  });

  it('ignores comment lines (col-7 indicator) and blank lines', () => {
    const pf = parseCobolSource('payprog.cob', 'payment', false, PROGRAM);
    // the banner comment block must not become a paragraph or inflate codeLines
    const names = pf.functions.map((f) => f.name);
    expect(names).not.toContain('*');
    expect(pf.codeLines).toBeGreaterThan(0);
  });

  it('does not mistake a numeric PERFORM n TIMES for a paragraph ref', () => {
    const src = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. T5.
       PROCEDURE DIVISION.
       LOOP-PARA.
           PERFORM 5 TIMES
               DISPLAY 'X'
           END-PERFORM.
`;
    const pf = parseCobolSource('t5.cob', 'm', false, src);
    const loop = pf.functions.find((f) => f.name === 'LOOP-PARA')!;
    expect(loop.calls).not.toContain('5');
  });
});
