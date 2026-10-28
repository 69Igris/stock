// Trade validations
export {
  TradeFormSchema,
  ClosePositionSchema,
  TradeFilterSchema,
  type TradeFormInput,
  type TradeFormData,
  type ClosePositionInput,
  type TradeFilterInput,
} from "./trade";

// Holding validations
export { HoldingFormSchema, type HoldingFormInput } from "./holding";

// Mutual Fund validations
export { MutualFundFormSchema, type MutualFundFormInput } from "./mutual-fund";

// FIRE validations
export {
  MonthlyExpenseSchema,
  OneTimeExpenseSchema,
  FireParametersSchema,
  FireScenarioSchema,
  type FireParametersInput,
  type FireScenarioInput,
} from "./fire";

// Coupon validations (MONEY-866)
export {
  CouponCreateSchema,
  CouponUpdateSchema,
  type CouponCreateInput,
  type CouponUpdateInput,
} from "./coupon";

// Common types
export type { ActionResponse, PaginatedResponse } from "./common";

// Content validations
export {
  ContentTypeEnum,
  PostStatusEnum,
  ContentRoleEnum,
  ContentPlatformEnum,
  CreatePostSchema,
  UpdatePostSchema,
  CreateTagSchema,
  UpdateTagSchema,
  CreateAuthorSchema,
  PostFilterSchema,
  PostPaginationSchema,
  PublishPostSchema,
  type CreatePostInput,
  type CreatePostData,
  type UpdatePostInput,
  type UpdatePostData,
  type CreateTagInput,
  type CreateTagData,
  type UpdateTagInput,
  type UpdateTagData,
  type CreateAuthorInput,
  type CreateAuthorData,
  type PostFilterInput,
  type PostFilterData,
  type PostPaginationInput,
  type PostPaginationData,
  type PublishPostInput,
  type PublishPostData,
  IdeaStatusEnum,
  IdeaStageEnum,
  CreateIdeaSchema,
  UpdateIdeaSchema,
  type CreateIdeaInput,
  type CreateIdeaData,
  type UpdateIdeaInput as UpdateIdeaValidationInput,
  type UpdateIdeaData,
} from "./content";

// Chat block validations
export {
  TableBlockSchema,
  TableColumnSchema,
  CardBlockSchema,
  CardItemSchema,
  ChartBlockSchema,
  ChartYKeySchema,
  ActionBlockSchema,
  NavigationBlockSchema,
  NavigationLinkSchema,
  ComparisonBlockSchema,
  ComparisonItemSchema,
  ComparisonMetricSchema,
  ErrorBlockSchema,
  BLOCK_SCHEMAS,
  validateBlockData,
} from "./chat-blocks";

// Paper trading validations
export {
  PlaceOrderSchema,
  type PlaceOrderInput,
  type PlaceOrderData,
} from "./paper";

// Document validations
export {
  DocumentCategorySchema,
  DocumentSourceTypeSchema,
  DocumentFilterSchema,
  UploadDocumentSchema,
  ImportUrlSchema,
  FetchNseDocumentSchema,
  GenerateReportSchema,
  type DocumentCategoryInput,
  type DocumentFilterInput,
  type DocumentFilterData,
  type UploadDocumentInput,
  type UploadDocumentData,
  type ImportUrlInput,
  type ImportUrlData,
  type FetchNseDocumentInput,
  type GenerateReportInput,
  type GenerateReportData,
} from "./document";

// Feedback validations
export {
  FeedbackTypeEnum,
  FeedbackStatusEnum,
  CreateFeedbackSchema,
  FeedbackFilterSchema,
  AddFeedbackReplySchema,
  ResultFeedbackSurfaceEnum,
  ResultFeedbackRatingEnum,
  SubmitResultFeedbackSchema,
  type CreateFeedbackInput,
  type CreateFeedbackData,
  type FeedbackFilterInput,
  type FeedbackFilterData,
  type AddFeedbackReplyInput,
  type AddFeedbackReplyData,
  type SubmitResultFeedbackInput,
  type SubmitResultFeedbackData,
} from "./feedback";

// Re-export zod for convenience
export { z } from "zod";
