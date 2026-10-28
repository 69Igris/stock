/**
 * Shared service layer types.
 *
 * ServiceResult<T> is the canonical return type for all service functions.
 * It is structurally compatible with ActionResponse<T> from @usemoney/validation,
 * so server actions can return service results directly.
 */

export type ServiceResult<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string; code?: string };
