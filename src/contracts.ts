/** Shared wire contracts. Runtime validators reject unknown keys. */
export interface DraftCandidate {
  email_subject: string;
  email_body: string;
}

export interface Draft extends DraftCandidate {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type DraftUpdate = DraftCandidate;

export interface PublicConfig {
  maxUploadBytes: number;
  validationLimits: {
    maxRequestBytes: number;
    maxSubjectChars: number;
    maxBodyChars: number;
  };
}

/** IDs and indices identify source records. Timestamps have no inferred timezone. */
export interface TranscriptMessage {
  id: string;
  index: number;
  timestamp: string;
  sender: string | null;
  text: string;
  kind: "message" | "attachment" | "system";
}

/** One transcript and optional language (defaults to English) for POST /api/generate. */
export interface GenerateRequest { transcript: string | File; language?: "en" | "ar" }

export type ErrorCode =
  | "CONFIGURATION_ERROR" | "INVALID_REQUEST"
  | "UPLOAD_TOO_LARGE" | "TRANSCRIPT_TOO_LARGE" | "MESSAGE_TOO_LARGE" | "PARSE_ERROR"
  | "MODEL_OUTPUT_TOO_LARGE" | "SYNTHESIS_INPUT_TOO_LARGE"
  | "MODEL_UNAVAILABLE" | "MODEL_TIMEOUT" | "MODEL_REQUEST_FAILED"
  | "INVALID_MODEL_RESPONSE" | "CANCELLED" | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED" | "STORAGE_ERROR" | "INVALID_STREAM" | "INTERNAL_ERROR";

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface ErrorResponse { error: ApiError }
export type StageEvent = { type: "stage"; stage: "synthesis"; completed: number; total: number };
export type ResultEvent = { type: "result"; draft: DraftCandidate };
export type PipelineErrorEvent = { type: "error" } & ApiError;
export type DoneEvent = { type: "done" };

/** stage* -> result -> done, or stage* -> error. Nothing follows a terminal event. */
export type GenerationEvent = StageEvent | ResultEvent | PipelineErrorEvent | DoneEvent;

/** Success bodies are bare values, except 204 which has no body. Errors use ErrorResponse. */
export interface ApiRoutes {
  "GET /api/config": { response: PublicConfig };
  "POST /api/generate": { request: GenerateRequest; event: GenerationEvent };
  "GET /api/drafts": { response: Draft[] };
  "GET /api/drafts/:id": { response: Draft };
  "POST /api/drafts": { request: DraftCandidate; response: Draft; status: 201 };
  "PUT /api/drafts/:id": { request: DraftUpdate; response: Draft };
  "DELETE /api/drafts/:id": { status: 204 };
}
