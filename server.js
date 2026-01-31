import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.post('/analyze', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let browser;
    try {
        console.log(`Starting analysis for: ${url}`);

        // Launch browser
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // critical for docker/render
                '--disable-gpu'
            ],
            defaultViewport: { width: 1440, height: 900 }
        });

        const page = await browser.newPage();

        // Set User Agent to look like a real browser
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // Optimize navigation: Don't wait for every network connection (ads/analytics)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Small buffer to ensure styles are applied if they rely on JS
        await new Promise(r => setTimeout(r, 2000));

        // 1. DATA EXTRACTION IN BROWSER CONTEXT
        const data = await page.evaluate(() => {
            // --- HELPER: COLOR CONVERSION (RGB to HEX) ---
            const rgbToHex = (rgb) => {
                if (!rgb) return null;
                if (rgb.startsWith('#')) return rgb;
                const result = rgb.match(/\d+/g);
                if (!result || result.length < 3) return null;
                return "#" + ((1 << 24) + (parseInt(result[0]) << 16) + (parseInt(result[1]) << 8) + parseInt(result[2])).toString(16).slice(1).toUpperCase();
            };

            // --- 1. COLORS ---
            const colorCounts = {};
            const addColor = (c, weight = 1) => {
                const hex = rgbToHex(c);
                if (hex && hex !== '#FFFFFF' && hex !== '#000000' && hex !== '#00000000') {
                    colorCounts[hex] = (colorCounts[hex] || 0) + weight;
                }
            };

            // A. Meta Theme Color (High Confidence)
            const themeColor = document.querySelector('meta[name="theme-color"]');
            if (themeColor) addColor(themeColor.content, 20);

            // B. Analyze Header/Nav Buttons (Primary Action Candidates)
            const header = document.querySelector('header') || document.querySelector('nav');
            if (header) {
                const headerButtons = header.querySelectorAll('button, a[class*="btn"], a[class*="button"]');
                headerButtons.forEach(btn => {
                    const style = window.getComputedStyle(btn);
                    // Background
                    addColor(style.backgroundColor, 10);
                    // Text color (if background is transparent)
                    if (style.backgroundColor === 'rgba(0, 0, 0, 0)') {
                        addColor(style.color, 5);
                    }
                });

                // C. Inline SVGs in Header (Brand Logos often have specific fills)
                const headerSvgs = header.querySelectorAll('svg path, svg rect, svg circle, svg g, svg');
                headerSvgs.forEach(svgPart => {
                    const style = window.getComputedStyle(svgPart);
                    const fill = style.fill;
                    const stroke = style.stroke;
                    if (fill && fill !== 'none') addColor(fill, 8);
                    if (stroke && stroke !== 'none') addColor(stroke, 8);
                });
            }

            // D. Main Content Buttons
            const buttons = document.querySelectorAll('button, a[class*="btn"], .button, .btn');
            buttons.forEach(btn => {
                const bg = window.getComputedStyle(btn).backgroundColor;
                addColor(bg, 3);
            });

            // E. Sort Colors
            const sortedColors = Object.entries(colorCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(entry => entry[0]);

            // Heuristic: Primary is the most weighted color
            const primaryColor = sortedColors[0] || '#000000';
            const bgColor = window.getComputedStyle(document.body).backgroundColor;


            // --- 2. LOGO ---
            // Strategy: 
            // 1. Header/Nav img with 'logo' in class/id/src (Highest)
            // 2. SVG in Link to Home (Common pattern)
            // 3. OG:Image (Fallback, usually accurate but maybe not transparent)
            // 4. Apple Touch Icon (Fallback)

            let logoUrl = null;

            // Check Header Images first
            const logoImg = Array.from(document.querySelectorAll('header img, nav img')).find(img =>
                (img.className && typeof img.className === 'string' && img.className.toLowerCase().includes('logo')) ||
                (img.src && img.src.toLowerCase().includes('logo')) ||
                (img.alt && img.alt.toLowerCase().includes('logo'))
            );
            if (logoImg) logoUrl = logoImg.src;

            // If no image, look for SVG inside an anchor tag linking to root
            if (!logoUrl) {
                const homeLinks = Array.from(document.querySelectorAll('a[href="/"], a[href="' + window.location.origin + '"]'));
                const logoLink = homeLinks.find(link => link.querySelector('svg'));
                if (logoLink) {
                    // Creating a data URI for the SVG is complex, here we assume extraction outside or finding img tag
                    // We check if the SVG has a logo class or similar
                    // Simplified: If inside home link, likely logo.
                    const svg = logoLink.querySelector('svg');
                    if (svg) {
                        logoUrl = `data:image/svg+xml;base64,${window.btoa(svg.outerHTML)}`;
                    }
                }
            }

            // Fallbacks
            if (!logoUrl) {
                const ogImage = document.querySelector('meta[property="og:image"]');
                if (ogImage) logoUrl = ogImage.content;
            }
            if (!logoUrl) {
                const appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
                if (appleIcon) logoUrl = appleIcon.href;
            }


            // --- 3. TYPOGRAPHY ---
            const bodyFn = window.getComputedStyle(document.body).fontFamily.split(',')[0].replace(/['"]/g, '');
            const h1 = document.querySelector('h1');
            const headingFn = h1 ? window.getComputedStyle(h1).fontFamily.split(',')[0].replace(/['"]/g, '') : bodyFn;


            // --- 4. CONTENT ANALYTICS ---
            const heroText = h1 ? h1.innerText : '';
            const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
            const bodyText = document.body.innerText.slice(0, 500);

            return {
                colors: {
                    primary: primaryColor,
                    background: rgbToHex(bgColor),
                    palette: sortedColors
                },
                typography: {
                    headings: headingFn,
                    body: bodyFn
                },
                logo: logoUrl,
                rawText: `Heading: ${heroText}\nDescription: ${metaDesc}\nContent: ${bodyText}`
            };
        });

        // 2. VIBE CHECK (LLM INTEGRATION)
        let vibeAnalysis = {
            tone: "Analyzing...",
            audience: "General",
            summary: "Could not generate analysis."
        };

        try {
            console.log("Environment Keys Check:", {
                google: !!process.env.GOOGLE_API_KEY,
                openai: !!process.env.OPENAI_API_KEY
            });

            if (process.env.GOOGLE_API_KEY) {
                console.log("Using Google Gemini...");
                const { GoogleGenerativeAI } = await import('@google/generative-ai');
                const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
                // Use a stable model
                const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

                const prompt = `Analyze this website content and return a JSON object with: 
            1. "tone" (2 words max, e.g. "Minimalist Tech", "Playful Modern"), 
            2. "audience" (2 words max, e.g. "Designers", "Developers"), 
            3. "vibe" (1 short sentence describing the visual style, UI aesthetics, and design vibe. e.g., "Corporate Memphis with glassmorphism").
            
            Content: ${data.rawText}`;

                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();
                console.log("Raw LLM Response:", text); // Debug log

                // Clean markdown json
                const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
                vibeAnalysis = JSON.parse(cleaned);
                console.log("Gemini Analysis Complete");

            } else if (process.env.OPENAI_API_KEY) {
                console.log("Using OpenAI...");
                const { OpenAI } = await import('openai');
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: "system", content: "You are a design expert focused on UI/UX aesthetics." },
                        {
                            role: "user", content: `Analyze the vibe of this text. Return JSON: { "tone": "...", "audience": "...", "vibe": "..." }. 
                        Summary instructions: Describe the visual style, UI aesthetics, and design vibe. Do NOT describe what the company sells/offers, focus ONLY on the look and feel.
                        Text: ${data.rawText}`
                        }
                    ],
                    model: "gpt-3.5-turbo",
                    response_format: { type: "json_object" }
                });
                vibeAnalysis = JSON.parse(completion.choices[0].message.content);
                console.log("OpenAI Analysis Complete");
            } else {
                // Mock Fallback if no keys
                console.log("No API keys found. Using Demo Mode.");
                vibeAnalysis = {
                    tone: "Demo Mode",
                    audience: "No API Key",
                    vibe: "Key missing. Check .env file and restart server."
                };
            }
        } catch (e) {
            console.error("LLM Analysis failed:", e);
            vibeAnalysis = {
                tone: "Error",
                audience: "Analysis Failed",
                vibe: `Error: ${e.message || e.toString()}`
            };
        }

        res.json({ ...data, vibe: vibeAnalysis });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to analyze URL', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
