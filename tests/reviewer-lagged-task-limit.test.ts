import { describe, expect, it, jest } from "@jest/globals";
import { Context } from "../src/types/context";
import { Review } from "../src/types/payload";
import { AssignedIssueScope, Role } from "../src/types/plugin-input";
import { getPendingOpenedPullRequests } from "../src/utils/issue";

const USERNAME = "contributor";
const REVIEWER_ID = 1001;
const ONE_HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * ONE_HOUR_MS).toISOString();
}

function createReview(overrides: Partial<Review> = {}) {
  return {
    author_association: "MEMBER",
    state: "CHANGES_REQUESTED",
    submitted_at: hoursAgo(30),
    user: {
      id: REVIEWER_ID,
      login: "reviewer",
    },
    ...overrides,
  } as Review;
}

function createContext({
  graphQlError = false,
  reviewDelayTolerance = "3 Days",
  reviews = [],
  reviewRequestedHoursAgo = 96,
  threads = [],
}: {
  graphQlError?: boolean;
  reviewDelayTolerance?: string;
  reviews?: Review[];
  reviewRequestedHoursAgo?: number;
  threads?: {
    isResolved?: boolean;
    lastAuthor?: string;
    lastCommentHoursAgo?: number;
  }[];
} = {}) {
  const searchMethod = jest.fn();
  const reviewsMethod = jest.fn();
  const timelineMethod = jest.fn();
  const pullRequest = {
    created_at: hoursAgo(120),
    html_url: "https://github.com/ubiquity-os-marketplace/command-start-stop/pull/123",
    number: 123,
    requested_reviewers: [],
    user: {
      login: USERNAME,
    },
  };
  const paginate = jest.fn(async (method) => {
    if (method === searchMethod) {
      return [pullRequest];
    }
    if (method === reviewsMethod) {
      return reviews;
    }
    if (method === timelineMethod) {
      return [
        {
          created_at: hoursAgo(reviewRequestedHoursAgo),
          event: "review_requested",
        },
      ];
    }
    return [];
  });
  const graphqlPaginate = jest.fn(async () => {
    if (graphQlError) {
      throw new Error("GraphQL unavailable");
    }
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((thread) => ({
              isResolved: thread.isResolved ?? false,
              comments: {
                nodes: [
                  {
                    author: {
                      login: thread.lastAuthor ?? USERNAME,
                    },
                    createdAt: hoursAgo(thread.lastCommentHoursAgo ?? 25),
                  },
                ],
              },
            })),
          },
        },
      },
    };
  });
  const context = {
    config: {
      assignedIssueScope: AssignedIssueScope.REPO,
      reviewDelayTolerance,
      rolesWithReviewAuthority: [Role.ADMIN, Role.OWNER, Role.MEMBER],
    },
    logger: {
      debug: jest.fn(),
      error: jest.fn((message: string) => new Error(message)),
    },
    octokit: {
      graphql: {
        paginate: graphqlPaginate,
      },
      paginate,
      rest: {
        issues: {
          listEventsForTimeline: timelineMethod,
        },
        pulls: {
          listReviews: reviewsMethod,
        },
        search: {
          issuesAndPullRequests: searchMethod,
        },
      },
    },
    organizations: ["ubiquity-os-marketplace"],
    payload: {
      repository: {
        full_name: "ubiquity-os-marketplace/command-start-stop",
      },
    },
  } as unknown as Context;

  return { context, graphqlPaginate };
}

describe("reviewer-lagged task limit credit", () => {
  it("credits a stale pull request without reviews", async () => {
    const { context } = createContext();

    await expect(getPendingOpenedPullRequests(context, USERNAME)).resolves.toHaveLength(1);
  });

  it("credits a changes-requested pull request when the author replied to every unresolved review thread", async () => {
    const { context } = createContext({
      reviews: [createReview()],
      threads: [{ lastAuthor: USERNAME, lastCommentHoursAgo: 25 }],
    });

    await expect(getPendingOpenedPullRequests(context, USERNAME)).resolves.toHaveLength(1);
  });

  it("does not credit a changes-requested pull request when review threads still need author action", async () => {
    const { context } = createContext({
      reviews: [createReview()],
      threads: [{ lastAuthor: "reviewer", lastCommentHoursAgo: 25 }],
    });

    await expect(getPendingOpenedPullRequests(context, USERNAME)).resolves.toHaveLength(0);
  });

  it("does not credit a changes-requested pull request when the author's last reply is less than 24 hours old", async () => {
    const { context } = createContext({
      reviews: [createReview()],
      threads: [{ lastAuthor: USERNAME, lastCommentHoursAgo: 2 }],
    });

    await expect(getPendingOpenedPullRequests(context, USERNAME)).resolves.toHaveLength(0);
  });

  it("falls back conservatively if review thread inspection fails", async () => {
    const { context, graphqlPaginate } = createContext({
      graphQlError: true,
      reviews: [createReview()],
    });

    await expect(getPendingOpenedPullRequests(context, USERNAME)).resolves.toHaveLength(0);
    expect(graphqlPaginate).toHaveBeenCalled();
  });
});
