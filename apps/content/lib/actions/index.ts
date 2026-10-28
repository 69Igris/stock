// Post actions
export {
  createPost,
  updatePost,
  archivePost,
  deletePost,
  publishPost,
  resendNewsletter,
  unpublishPost,
  getPostById,
} from "./posts";

// Tag actions
export {
  createTag,
  updateTag,
  deleteTag,
  getTagBySlug,
  listTags,
} from "./tags";

// Author actions
export {
  getOrCreateAuthor,
  updateAuthorRole,
  getAuthorByClerkId,
  getCurrentAuthor,
  listAuthors,
  updateAuthorProfile,
  inviteAuthor,
  listInvites,
  revokeInvite,
} from "./authors";

// Dashboard actions
export {
  fetchDashboardStats,
  fetchRecentPostsList,
  fetchPostTitleById,
  fetchAllPosts,
  fetchAllPostsCount,
  type DashboardStats,
  type PostListType,
} from "./dashboard";

// Ideas actions
export {
  createIdea,
  listIdeas,
  getIdeaById,
  updateIdea,
  deleteIdea,
  convertIdeaToDraft,
  getIdeasCount,
} from "./ideas";

// Search actions
export { searchPostsAtlas } from "./search";

// Subscriber actions
export {
  getSubscriberStats,
  listSubscribers,
  unsubscribeSubscriber,
  exportSubscribersCSV,
  syncSubscribersFromResend,
  toggleSubscription,
  updateSubscriberSegments,
  getSubscriberById,
  updateSubscriber,
  deleteSubscriber,
  getSubscriberTimeline,
  searchUsersForIndividualSend,
  type SubscriberFilter,
  type SubscriberDetail,
  type TimelineEvent,
} from "./subscribers";

// Analytics actions
export {
  getAnalyticsOverview,
  getPostAnalytics,
  getTopPostsByViews,
  getSubscriberActivity,
  getBroadcastDetails,
  type AnalyticsOverview,
  type PostAnalytics,
  type SubscriberActivity,
} from "./analytics";
