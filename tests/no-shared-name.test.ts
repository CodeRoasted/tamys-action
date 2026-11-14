// DN-160.O1 arm 12: no shared default name is left. The constant two jobs collided on survives only
// as the prefix of the derived names, and the baseline publisher takes its name from its caller —
// a default parameter is how every job came to publish one lineage (DN-160.D1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { publishBaselineLog } from '../src/artifact.js';
import * as types from '../src/types.js';

// ── Arm 12: no default constant left ───────────────────────────────────────────────────────

test('DN-160.O1 arm 12: the shared names survive only as prefixes, and publishBaselineLog takes no default name', () => {
    const exported = types as unknown as Record<string, unknown>;
    assert.equal(exported['BASELINE_ARTIFACT_NAME'], undefined, 'the shared baseline constant must be gone');
    assert.equal(exported['TAMYS_REPORT_ARTIFACT_NAME'], undefined, 'the shared report constant must be gone');
    assert.equal(exported['BASELINE_ARTIFACT_PREFIX'], 'tamys-baseline');
    assert.equal(exported['TAMYS_REPORT_ARTIFACT_PREFIX'], 'tamys-report');
    // `length` counts the parameters before the first one with a default: log, token, transport,
    // subject and name are all required; only the upload client defaults.
    assert.equal(publishBaselineLog.length, 5, `publishBaselineLog requires ${publishBaselineLog.length} parameters`);
});
