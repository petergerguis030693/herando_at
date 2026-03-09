<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">

  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="shortcut icon" href="/assets/herando-weblogo.png" type="image/x-icon"/>
        <title>XML Sitemap</title>
        <style>
          body {
            margin: 0;
            background: #ececec;
            color: #3f3f3f;
            font-family: Arial, Helvetica, sans-serif;
          }
          .wrap {
            max-width: 1220px;
            margin: 0;
            padding: 0;
          }
          h1 {
            margin: 0 0 14px;
            font-size: 46px;
            line-height: 1.1;
            color: #3f3f3f;
            font-weight: 700;
          }
          .intro {
            padding: 0 6px 16px;
            font-size: 18px;
            line-height: 1.45;
          }
          .intro p {
            margin: 14px 0;
          }
          .intro a {
            color: #e14b23;
            text-decoration: none;
            font-weight: 700;
            font-size: 16px;
          }
          .intro a:hover {
            text-decoration: underline;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
            font-size: 35px;
          }
          thead th {
            text-align: left;
            padding: 0 8px 8px;
            color: #3f3f3f;
            font-weight: 700;
            border-bottom: 1px solid #bcbcbc;
          }
          tbody td {
            padding: 6px 8px;
            border-top: 1px solid #d4d4d4;
            vertical-align: top;
          }
          tbody tr:nth-child(odd) td {
            background: #e2e2e2;
          }
          .url a {
            color: #000;
            text-decoration: none;
          }
          .url a:hover {
            text-decoration: underline;
          }
          .lastmod {
            width: 280px;
            white-space: nowrap;
            color: #4e4e4e;
            font-size: 18px;
          }
          @media (max-width: 1100px) {
            h1 { font-size: 32px; }
            .intro { font-size: 18px; }
            table { font-size: 18px; }
            .lastmod { width: 200px; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="intro">
            <h1>XML Sitemap</h1>
            <p>
              This is an XML Sitemap, meant for consumption by search engines.
            </p>
            <p>
              You can find more information about XML sitemaps on
              <a href="https://www.sitemaps.org/" target="_blank" rel="noopener">sitemaps.org</a>.
            </p>

            <xsl:choose>
              <xsl:when test="sm:sitemapindex">
                <p>
                  This XML Sitemap index contains
                  <xsl:value-of select="count(sm:sitemapindex/sm:sitemap)"/>
                  sitemap(s).
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Sitemap</th>
                      <th class="lastmod">Last Mod.</th>
                    </tr>
                  </thead>
                  <tbody>
                    <xsl:for-each select="sm:sitemapindex/sm:sitemap">
                      <tr>
                        <td class="url">
                          <a href="{sm:loc}">
                            <xsl:value-of select="sm:loc"/>
                          </a>
                        </td>
                        <td class="lastmod">
                          <xsl:value-of select="sm:lastmod"/>
                        </td>
                      </tr>
                    </xsl:for-each>
                  </tbody>
                </table>
              </xsl:when>
              <xsl:when test="sm:urlset">
                <p>
                  This XML Sitemap contains
                  <xsl:value-of select="count(sm:urlset/sm:url)"/>
                  URL(s).
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>URL</th>
                      <th class="lastmod">Last Mod.</th>
                    </tr>
                  </thead>
                  <tbody>
                    <xsl:for-each select="sm:urlset/sm:url">
                      <tr>
                        <td class="url">
                          <a href="{sm:loc}">
                            <xsl:value-of select="sm:loc"/>
                          </a>
                        </td>
                        <td class="lastmod">
                          <xsl:value-of select="sm:lastmod"/>
                        </td>
                      </tr>
                    </xsl:for-each>
                  </tbody>
                </table>
              </xsl:when>
            </xsl:choose>
          </div>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
