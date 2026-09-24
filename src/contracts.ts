/** Shared wire contracts. Runtime validators must reject unknown keys and invalid references. */
export type Department = "operations" | "administration";
export const DEPARTMENTS = ["operations", "administration"] as const;

export interface DepartmentConfig {
  id: Department;
  name: string;
  email: string;
}

export interface DraftCandidate {
  client_name: string;
  department: Department;
  parent_draft_id: string | null;
  recipient_email: string;
  email_subject: string;
  email_body: string;
}

export interface Draft extends DraftCandidate {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type DraftUpdate = Pick<DraftCandidate, "recipient_email" | "email_subject" | "email_body">;
export interface PublicConfig {
  departments: DepartmentConfig[];
  maxUploadBytes: number;
  validationLimits: {
    maxRequestBytes: number;
    maxAnalysisBytes: number;
    maxClientNameChars: number;
    maxSubjectChars: number;
    maxBodyChars: number;
  };
}

/** IDs are stable within one export; index is zero-based source order. No timezone is inferred. */
export interface SourceReference {
  id: string;
  index: number;
  timestamp: string;
}

export interface TranscriptMessage extends SourceReference {
  sender: string | null;
  text: string;
  kind: "message" | "attachment" | "system";
  /** True at the first message and after a gap >= six hours. */
  boundary_before: boolean;
}

export interface TranscriptChunk {
  id: string;
  index: number;
  messages: TranscriptMessage[];
}

export interface Conversation {
  id: string;
  source_message_ids: string[];
  outcome_summary: string;
}

export type ClientFactKind =
  | "identity" | "service_needs" | "scope" | "location" | "budget"
  | "timing" | "requirements" | "enquiry_status" | "commercial_terms";

export interface ClientFact {
  kind: ClientFactKind;
  value: string;
  source_message_ids: string[];
}

export interface PendingAction {
  id: string;
  description: string;
  source_message_ids: string[];
  completion_uncertain: boolean;
}

/** Temporary only. Ordered catalog allows reference validation without retaining transcript text. */
export interface TemporaryAnalysis {
  source_messages: SourceReference[];
  conversations: Conversation[];
  client_facts: ClientFact[];
  pending_actions: PendingAction[];
}

/** Extraction-only evidence; completed events never become pending actions. */
export interface ActionEvent {
  description: string;
  status: "requested" | "committed" | "completed" | "completion_uncertain";
  source_message_ids: string[];
}

export interface ConversationSegment extends Conversation {
  /** Only the first segment may continue the preceding chunk, never across a mandatory boundary. */
  continues_previous: boolean;
}

export interface ChunkExtraction {
  conversations: ConversationSegment[];
  client_facts: ClientFact[];
  action_events: ActionEvent[];
}

/** Model output deliberately excludes recipient, client identity, department and saved-draft metadata. */
export interface DepartmentModelResult {
  email_subject: string;
  email_body: string;
}

/** Multipart wire fields for POST /api/generate. */
export interface GenerateRequest {
  transcript: File;
  clientName: string;
}

export interface GenerateDepartmentRequest {
  clientName: string;
  department: Department;
  analysis: TemporaryAnalysis;
  parentDraftId?: string | null;
}

export type ErrorCode =
  | "CONFIGURATION_ERROR" | "INVALID_REQUEST" | "INVALID_EMAIL"
  | "UPLOAD_TOO_LARGE" | "TRANSCRIPT_TOO_LARGE" | "MESSAGE_TOO_LARGE"
  | "CHUNK_TOO_LARGE" | "TOO_MANY_CHUNKS" | "PARSE_ERROR"
  | "INVALID_ANALYSIS" | "MODEL_OUTPUT_TOO_LARGE" | "CHUNK_RESULT_TOO_LARGE"
  | "ANALYSIS_TOO_LARGE" | "SYNTHESIS_INPUT_TOO_LARGE"
  | "MODEL_UNAVAILABLE" | "MODEL_TIMEOUT" | "MODEL_REQUEST_FAILED"
  | "INVALID_MODEL_RESPONSE" | "CANCELLED" | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED" | "STORAGE_ERROR" | "INVALID_PARENT"
  | "INVALID_STREAM" | "INTERNAL_ERROR";

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ErrorResponse { error: ApiError }

export type StageEvent =
  | { type: "stage"; stage: "extraction" | "reconciliation"; completed: number; total: number }
  | { type: "stage"; stage: "synthesis"; department: Department; completed: number; total: number };

/** Mapped union prevents the envelope and candidate departments from disagreeing. */
export type DepartmentResultEvent = {
  [D in Department]: { type: "department_result"; department: D; draft: DraftCandidate & { department: D } }
}[Department];

export type DepartmentErrorEvent = { type: "department_error"; department: Department } & ApiError;
export type AnalysisEvent = { type: "analysis"; analysis: TemporaryAnalysis };
export type PipelineErrorEvent = { type: "error" } & ApiError;
export type DoneEvent = { type: "done" };

/**
 * Initial: stage* -> analysis (once) -> independent outcomes -> done.
 * Department-only: stage* -> selected outcome -> done (no analysis event).
 * Exactly one result/error per requested department before done, in either order.
 * Shared failure terminates with error instead of done. No event follows either terminal.
 * Consumers must reject duplicate outcomes and EOF without a terminal event.
 */
export type GenerationEvent = StageEvent | AnalysisEvent | DepartmentResultEvent
  | DepartmentErrorEvent | PipelineErrorEvent | DoneEvent;

/** Success bodies are bare values, except 204 which has no body. Errors use ErrorResponse. */
export interface ApiRoutes {
  "GET /api/config": { response: PublicConfig };
  "POST /api/generate": { request: GenerateRequest; event: GenerationEvent };
  "POST /api/generate/department": { request: GenerateDepartmentRequest; event: GenerationEvent };
  "GET /api/drafts": { response: Draft[] };
  "GET /api/drafts/:id": { response: Draft };
  "POST /api/drafts": { request: DraftCandidate; response: Draft; status: 201 };
  "PUT /api/drafts/:id": { request: DraftUpdate; response: Draft };
  "DELETE /api/drafts/:id": { status: 204 };
}

export const NO_PENDING_ACTIONS = "No pending actions identified in the chat.";
export const COMPLETION_NOT_CONFIRMED = "Completion not confirmed";
