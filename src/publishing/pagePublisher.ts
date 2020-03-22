import * as Utils from "@paperbits/common/utils";
import template from "./page.html";
import { minify } from "html-minifier-terser";
import { IPublisher, HtmlPage, HtmlPagePublisher, SearchIndexBuilder } from "@paperbits/common/publishing";
import { IBlobStorage } from "@paperbits/common/persistence";
import { IPageService, PageContract } from "@paperbits/common/pages";
import { ISiteService } from "@paperbits/common/sites";
import { Logger } from "@paperbits/common/logging";
import { ILocaleService } from "@paperbits/common/localization";
import { IMediaService } from "@paperbits/common/media";
import { StyleCompiler, StyleManager } from "@paperbits/common/styles";
import { SitemapBuilder } from "@paperbits/common/publishing/sitemapBuilder";
import { LocalStyleBuilder } from "./localStyleBuilder";


export class PagePublisher implements IPublisher {
    private localStyleBuilder: LocalStyleBuilder;

    constructor(
        private readonly pageService: IPageService,
        private readonly siteService: ISiteService,
        private readonly mediaService: IMediaService,
        private readonly outputBlobStorage: IBlobStorage,
        private readonly htmlPagePublisher: HtmlPagePublisher,
        private readonly styleCompiler: StyleCompiler,
        private readonly localeService: ILocaleService,
        private readonly logger: Logger
    ) {
        this.localStyleBuilder = new LocalStyleBuilder(this.outputBlobStorage);
    }

    public async renderPage(page: HtmlPage): Promise<string> {
        this.logger.traceEvent(`Publishing page ${page.title}...`);

        try {
            const htmlContent = await this.htmlPagePublisher.renderHtml(page);

            return minify(htmlContent, {
                caseSensitive: true,
                collapseBooleanAttributes: true,
                collapseInlineTagWhitespace: false,
                collapseWhitespace: true,
                html5: true,
                minifyCSS: true,
                preserveLineBreaks: false,
                removeComments: true,
                removeEmptyAttributes: true,
                removeOptionalTags: false,
                removeRedundantAttributes: false,
                removeScriptTypeAttributes: false,
                removeStyleLinkTypeAttributes: false,
                removeTagWhitespace: false,
                removeAttributeQuotes: false
            });
        }
        catch (error) {
            throw new Error(`Unable to reneder page ${page.title}: ${error.message}`);
        }
    }

    private async renderAndUpload(settings: any, page: PageContract, indexer: SearchIndexBuilder, locale?: string): Promise<void> {
        const siteAuthor = settings?.site?.author;
        const siteTitle = settings?.site?.title;
        const siteDescription = settings?.site?.description;
        const siteKeywords = settings?.site?.keywords;
        const siteHostname = settings?.site?.hostname;
        const faviconSourceKey = settings?.site?.faviconSourceKey;
        
        const localePrefix = locale ? `/${locale}` : "";
        
        const pagePermalink = `${localePrefix}${page.permalink}`;
        const pageContent = await this.pageService.getPageContent(page.key, locale);
        const pageUrl = siteHostname
            ? `https://${settings?.site?.hostname}${pagePermalink}`
            : pagePermalink;

        const styleManager = new StyleManager();

        const htmlPage: HtmlPage = {
            title: [page.title, siteTitle].join(" - "),
            description: page.description || siteDescription,
            keywords: page.keywords || siteKeywords,
            permalink: pagePermalink,
            url: pageUrl,
            siteHostName: siteHostname,
            content: pageContent,
            template: template,
            styleReferences: [
                `/styles/styles.css`, // global style reference
                pagePermalink === "/" // local style reference
                    ? `/styles.css`   // home page style reference
                    : `${pagePermalink}/styles.css`
            ],
            author: siteAuthor,
            socialShareData: page.socialShareData,
            openGraph: {
                type: page.permalink === "/" ? "website" : "article",
                title: page.title || siteTitle,
                description: page.description || siteDescription,
                siteName: siteTitle
            },
            bindingContext: {
                styleManager: styleManager,
                navigationPath: pagePermalink,
                locale: locale,
                template: {
                    page: {
                        value: pageContent,
                    }
                }
            }
        };

        if (page.jsonLd) {
            let structuredData: any;

            try {
                structuredData = JSON.parse(page.jsonLd);
                htmlPage.linkedData = structuredData;
            }
            catch (error) {
                console.log("Unable to parse page linked data: ", error);
            }
        }

        if (faviconSourceKey) {
            try {
                const media = await this.mediaService.getMediaByKey(faviconSourceKey);

                if (media) {
                    htmlPage.faviconPermalink = media.permalink;
                }
            }
            catch (error) {
                this.logger.traceError(error, "Could not retrieve favicon.");
            }
        }

        const htmlContent = await this.renderPage(htmlPage);

        // Building local styles
        const styleSheets = styleManager.getAllStyleSheets();
        this.localStyleBuilder.buildLocalStyle(pagePermalink, styleSheets);

        indexer.appendPage(pagePermalink, htmlPage.title, htmlPage.description, htmlContent);

        let permalink = pagePermalink;

        if (!permalink.endsWith("/")) {
            permalink += "/";
        }

        permalink = `${permalink}index.html`;

        const uploadPath = permalink;
        const contentBytes = Utils.stringToUnit8Array(htmlContent);

        await this.outputBlobStorage.uploadBlob(uploadPath, contentBytes, "text/html");
    }

    public async publish(): Promise<void> {
        const locales = await this.localeService.getLocales();
        const defaultLocale = await this.localeService.getDefaultLocale();
        const localizationEnabled = locales.length > 0;
        const globalStyleSheet = await this.styleCompiler.getStyleSheet();

        // Building global styles
        this.localStyleBuilder.buildGlobalStyle(globalStyleSheet);

        try {
            const results = [];
            const settings = await this.siteService.getSiteSettings();
            const sitemapBuilder = new SitemapBuilder(settings?.site?.hostname);
            const searchIndexBuilder = new SearchIndexBuilder();

            if (localizationEnabled) {
                for (const locale of locales) {
                    const localeCode = locale.code === defaultLocale
                        ? null
                        : locale.code;

                    const pages = await this.pageService.search("", localeCode);

                    for (const page of pages) {
                        results.push(this.renderAndUpload(settings, page, searchIndexBuilder, localeCode));
                        sitemapBuilder.appendPermalink(`${localeCode || ""}${page.permalink}`);
                    }
                }
            }
            else {
                const pages = await this.pageService.search("");

                for (const page of pages) {
                    results.push(this.renderAndUpload(settings, page, searchIndexBuilder));
                    sitemapBuilder.appendPermalink(page.permalink);
                }
            }

            await Promise.all(results);

            const sitemapXml = sitemapBuilder.buildSitemap();
            const contentBytes = Utils.stringToUnit8Array(sitemapXml);

            await this.outputBlobStorage.uploadBlob("sitemap.xml", contentBytes, "text/xml");

        }
        catch (error) {
            this.logger.traceError(error, "Page publisher");
        }
    }
}
