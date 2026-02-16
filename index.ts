export interface Env {
  lobsteRSS: KVNamespace;
}

class Story {
  title: string = "";
  commentsUrl: string = "";
  articleUrl: string = "";
  commentCount: string = "";
  upvotes: string = "";
  publishUnix: string = "";

  toRssItem(): string {
    const count = this.commentCount.replace(/\D/g, "") || "0";
    const points = this.upvotes.trim() || "0";

    // Convert Unix timestamp (seconds) to RFC 822 format
    const dateObj = this.publishUnix 
      ? new Date(parseInt(this.publishUnix) * 1000) 
      : new Date();
    const pubDate = dateObj.toUTCString();

    return `
    <item>
      <title><![CDATA[${this.title.trim()}]]></title>
      <link>${this.commentsUrl}</link>
      <guid isPermaLink="false">${this.commentsUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[
<p>Article URL: <a href="${this.articleUrl}">${this.articleUrl}</a></p>
<p>Comments URL: <a href="${this.commentsUrl}">${this.commentsUrl}</a></p>
<p>Points: ${points}</p>
<p># Comments: ${count}</p>
      ]]></description>
    </item>`;
  }
}

async function frontpageToXML(htmlResponse: Response, env: Env): Promise<string> {
  const stories: Story[] = [];
  let currentStory: Story | null = null;

  const rewriter = new HTMLRewriter()
    // Initialize a new story when entering the <li>
    .on("li.story", {
      element(el) {
        currentStory = new Story();
        el.onEndTag(() => {
          if (currentStory) stories.push(currentStory);
        });
      }
    })
    // Extract Upvotes
    .on("li.story .upvoter", {
      text(t) { if (currentStory) currentStory.upvotes += t.text; }
    })
    // Extract Title and Article URL
    .on("li.story .details .link a.u-url", {
      element(el) {
        if (currentStory) currentStory.articleUrl = el.getAttribute("href") || "";
      },
      text(t) { if (currentStory) currentStory.title += t.text; }
    })
    // Extract the publication date from the <time> tag
    .on("li.story .byline time", {
      element(el) {
        if (currentStory) {
          currentStory.publishUnix = el.getAttribute("data-at-unix") || "";
        }
      }
    })
    // Extract Comments URL and Count
    .on("li.story .byline .comments_label a", {
      element(el) {
        if (currentStory) {
          const href = el.getAttribute("href") || "";
          currentStory.commentsUrl = href.startsWith("/") 
            ? `https://lobste.rs${href}` 
            : href;
        }
      },
      text(t) { if (currentStory) currentStory.commentCount += t.text; }
    });

  // Execute the rewriter
  await rewriter.transform(htmlResponse).text();

  // Build the RSS Feed
  const lastBuildDate = (new Date()).toUTCString();
  const items = stories.map(s => s.toRssItem()).join("");
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Lobste.rs Front Page</title>
    <link>https://lobste.rs</link>
    <description>lobsteRSS Feed</description>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <docs>${env.DOCS}</docs>
    <generator>lobsteRSS v0.1</generator>
    <atom:link href="${env.HOST}/rss" rel="self" type="application/rss+xml"></atom:link>
    ${items}
  </channel>
</rss>`;
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/rss") {
      return new Response("Not Found", { status: 404 });
    }

    const rssContent = await env.lobsteRSS.get("feed");

    if (!rssContent) {
      return new Response("Feed not yet generated", { status: 503 });
    }

    return new Response(rssContent, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const scrapeAndStore = async () => {
      try {
        // Scrape front page
        const response = await fetch("https://lobste.rs/");
        const xmlFeed = await frontpageToXML(response, env); 

        // update KV store
        await env.lobsteRSS.put("feed", xmlFeed);
      } catch (err) {
        console.error("Scraping failed:", err);
      }
    };

    ctx.waitUntil(scrapeAndStore());
  },
};
