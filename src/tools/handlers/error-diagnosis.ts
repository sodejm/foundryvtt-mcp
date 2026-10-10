import { DIAGNOSTICS_UNAVAILABLE } from '../../foundry/capabilities.js';
import {
  errorDiagnosisOutputSchema,
  parseErrorDiagnosisInput,
} from '../../foundry/diagnosis-contract.js';
import { boundedReadResponse } from '../../foundry/read-contract.js';

/** Reports that no evidence-backed diagnostic source is implemented. */
export async function handleDiagnoseErrors(args: unknown) {
  parseErrorDiagnosisInput(args);
  const structuredContent = errorDiagnosisOutputSchema.parse({
    schemaVersion: 1,
    capability: DIAGNOSTICS_UNAVAILABLE,
  });

  return boundedReadResponse({
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}
