import type { ErrorCode } from './errors';

/** Metadata attached to every response. `requestId` correlates with server logs. */
export interface ResponseMeta {
  timestamp: string;
  requestId: string;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail. Only populated for VALIDATION_ERROR. */
    details?: Record<string, string[]>;
  };
  meta: ResponseMeta;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

/** Cursor pagination — used for timelines and any unbounded list. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Total rows matching the filter, across every page.
   *
   * Optional because a timeline does not need it and counting one is wasted
   * work. List screens do: without it the UI can only say "100 leads", which
   * is the page size rather than the truth.
   */
  total?: number | undefined;
}
