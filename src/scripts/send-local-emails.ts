import { getJobsFromR2, saveJobsToR2, ScrapedJob } from '../libs/r2-jobs-store';
import nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { resolve } from 'path';

// Load environment variables
dotenv.config();

const STACK_KEYWORDS = [
  { tag: 'golang', patterns: [/golang/i, /\bgo\b/i] },
  { tag: 'react', patterns: [/react/i, /reactjs/i] },
  { tag: 'nextjs', patterns: [/nextjs/i, /next\.js/i] },
  { tag: 'python', patterns: [/python/i] },
  { tag: 'fastapi', patterns: [/fastapi/i, /fast-api/i] },
  { tag: 'django', patterns: [/django/i] },
  { tag: 'laravel', patterns: [/laravel/i] },
  { tag: 'php', patterns: [/php/i] },
  { tag: 'mobile', patterns: [/mobile/i, /react-native/i, /reactnative/i, /expo/i, /flutter/i] },
  { tag: 'aws', patterns: [/aws/i, /amazon web services/i, /fargate/i] },
  { tag: 'nodejs', patterns: [/node/i, /nodejs/i, /express/i] },
  { tag: 'postgresql', patterns: [/postgres/i, /postgresql/i] },
  { tag: 'mongodb', patterns: [/mongo/i, /mongodb/i] },
  { tag: 'typescript', patterns: [/typescript/i, /\bts\b/i] },
  { tag: 'kubernetes', patterns: [/kubernetes/i, /k8s/i] },
  { tag: 'nestjs', patterns: [/nestjs/i, /nest\.js/i] },
  { tag: 'vue', patterns: [/vue/i, /vuejs/i] },
  { tag: 'angular', patterns: [/angular/i] },
];

function extractTags(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const tags: string[] = [];
  for (const item of STACK_KEYWORDS) {
    for (const pattern of item.patterns) {
      if (pattern.test(text)) {
        tags.push(item.tag);
        break;
      }
    }
  }
  return tags;
}

function getMailTransporter() {
  const { SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
  if (!SMTP_HOST || !EMAIL_USER || !EMAIL_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

function generatePitchEmail(job: ScrapedJob, tags: string[]): string {
  const recipientName = "Hiring Team";
  const companyName = job.company !== "Unknown Company" ? job.company : "your team";

  let projectBullets = "";
  if (tags.includes('golang') || tags.includes('aws')) {
    projectBullets += `- **Golang Distributed Chat System / Bridge**: Architected a real-time chat bridging network deployed on AWS Fargate serverless containers with ALB, PostgreSQL, and Redis.\n`;
  }
  if (tags.includes('nextjs') || tags.includes('react') || tags.includes('stripe')) {
    projectBullets += `- **Vine LMS (vinelms.com)**: Built a dynamic LMS using Next.js, Node.js/Express, PostgreSQL, and TanStack Query, integrating Stripe Connect, Reader Pay, and Stripe Meter.\n`;
  }
  if (tags.includes('python') || tags.includes('fastapi') || tags.includes('scraping') || tags.includes('django')) {
    projectBullets += `- **Anti-Bot Google Search Scraper**: Built a robust bypass/scraping engine in Python (FastAPI) and React utilizing Puppeteer and SeleniumBase.\n`;
  }
  if (tags.includes('nestjs') || tags.includes('vue') || tags.includes('kubernetes')) {
    projectBullets += `- **Enterprise E-Commerce Dashboard**: Created an administration panel using Vue.js 3, Pinia, NestJS, and containerized deployment with Kubernetes (K8s).\n`;
  }
  if (tags.includes('mobile') || tags.includes('flutter') || tags.includes('react-native')) {
    projectBullets += `- **Cross-Platform Mobile Apps**: Designed and deployed client applications using React Native, Expo, and Flutter with Redux Toolkit.\n`;
  }

  if (!projectBullets) {
    projectBullets += `- **Vine LMS (vinelms.com)**: High-performance Next.js and Node.js LMS with PostgreSQL and Stripe Connect.\n`;
    projectBullets += `- **Golang Distributed Chat System**: Scalable messaging bridge using Go, WebSockets, Redis, and AWS Fargate.\n`;
  }

  return `Dear ${recipientName},

I am writing to express my strong interest in the ${job.title} position at ${companyName}. As a Senior Full-Stack Developer with 2+ years of hands-on experience building enterprise management systems, scaling backend architectures, and designing responsive frontends, I am confident I can add immediate value to your team.

My technical background aligns closely with the requirements outlined in your job description. Here are a few relevant projects I have delivered:

${projectBullets}
I pride myself on writing clean, maintainable code in TypeScript, Golang, and Python, containerizing services via Docker/Kubernetes, and setting up automated CI/CD pipelines via GitHub Actions.

I have attached my tailored resume (which outlines my detailed experiences with Woltrio and Swismax) for your review. I would love the opportunity to discuss how my skill set can support ${companyName}'s engineering goals.

Thank you for your time and consideration.

Best regards,

Talha Riaz
Islamabad, Pakistan
+92 318 585347
talhariaz5425869@gmail.com
GitHub: github.com/talhary
Portfolio: talhacodes.site
`;
}

async function run() {
  console.log('🚀 Initializing Local Direct Email Apply Script...');

  const transporter = getMailTransporter();
  if (!transporter) {
    console.error('❌ Error: Nodemailer transporter could not be configured. Please check your SMTP configuration in .env.');
    process.exit(1);
  }

  console.log('🔄 Fetching jobs from R2...');
  const jobs = await getJobsFromR2();
  if (jobs.length === 0) {
    console.log('ℹ️ No jobs found in R2 database.');
    return;
  }

  console.log(`Loaded ${jobs.length} jobs. Filtering already applied companies...`);

  // Build the list of companies already applied/sent emails to
  const appliedCompanies = new Set<string>();
  for (const job of jobs) {
    if (job.appliedAt && job.company) {
      appliedCompanies.add(job.company.trim().toLowerCase());
    }
  }

  // Filter jobs targeting companies we haven't applied to yet
  const targetJobs = jobs.filter(job => {
    // 1. Skip if already applied to this specific job
    if (job.appliedAt) return false;

    // 2. Skip if we don't have email contacts
    if (!job.contacts?.emails || job.contacts.emails.length === 0) return false;

    // 3. Skip if it doesn't match our tech stack
    const tags = extractTags(job.title, job.description);
    if (tags.length === 0) return false;

    // 4. Skip if we've already applied to this company (except 'Unknown Company')
    if (job.company && job.company !== 'Unknown Company') {
      const compKey = job.company.trim().toLowerCase();
      if (appliedCompanies.has(compKey)) {
        return false;
      }
    }

    return true;
  });

  console.log(`Found ${targetJobs.length} matching jobs targeting new companies.`);
  if (targetJobs.length === 0) {
    console.log('ℹ️ No new companies/jobs left to apply to.');
    return;
  }

  const cvPort = process.env.CV_GENERATOR_PORT || '8082';

  for (let i = 0; i < targetJobs.length; i++) {
    const job = targetJobs[i];
    const primaryEmail = job.contacts!.emails[0];
    const companyKey = job.company ? job.company.trim().toLowerCase() : '';
    
    // Safety check again (in case multiple duplicate jobs are in the target list, we skip if already processed in this run)
    if (companyKey && companyKey !== 'unknown company' && appliedCompanies.has(companyKey)) {
      console.log(`[Skipped] Already applied to "${job.company}" in this run.`);
      continue;
    }

    console.log(`\n📬 [${i + 1}/${targetJobs.length}] Applying to "${job.title}" at "${job.company}" via email "${primaryEmail}"...`);

    try {
      const tags = extractTags(job.title, job.description);
      
      // Generate resume PDF from local CV generator with local fallback
      let pdfBuffer: ArrayBuffer | Buffer;
      try {
        console.log(`📄 Requesting resume generation for tags: [${tags.join(', ')}]...`);
        const cvResponse = await fetch(`http://localhost:${cvPort}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        });

        if (!cvResponse.ok) {
          throw new Error(`Go CV generator returned status ${cvResponse.status}`);
        }

        pdfBuffer = await cvResponse.arrayBuffer();
      } catch (fetchErr: any) {
        console.warn(`⚠️ Warning: Failed to generate tailored CV via Go server (${fetchErr.message || fetchErr}).`);
        const fallbackPath = resolve(process.cwd(), 'services/create-cv/Talha Riaz _ Senior Full-Stack Developer (1).pdf');
        if (fs.existsSync(fallbackPath)) {
          console.log(`ℹ️ Falling back to local resume: "${fallbackPath}"`);
          pdfBuffer = fs.readFileSync(fallbackPath);
        } else {
          throw new Error(`Resume generation failed and no fallback resume found at "${fallbackPath}"`);
        }
      }
      const emailBody = generatePitchEmail(job, tags);

      console.log(`✉️ Sending email via SMTP to "${primaryEmail}"...`);
      await transporter.sendMail({
        from: `"Talha Riaz" <${process.env.EMAIL_USER}>`,
        to: primaryEmail,
        subject: `Application for ${job.title} - Talha Riaz`,
        text: emailBody,
        attachments: [
          {
            filename: 'Talha_Riaz_Resume.pdf',
            content: Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer),
          }
        ]
      });

      console.log(`✅ Success! Email sent to ${primaryEmail} for "${job.company}".`);
      
      // Update applied status
      job.appliedAt = new Date().toISOString();
      if (companyKey && companyKey !== 'unknown company') {
        appliedCompanies.add(companyKey);
      }

      // Save immediately to R2 to persist application state
      console.log('💾 Syncing updated jobs database to R2...');
      const saved = await saveJobsToR2(jobs);
      if (saved) {
        console.log('✅ R2 updated successfully.');
      } else {
        console.warn('⚠️ Warning: Failed to update jobs database on R2.');
      }

      // Rate limit check: wait 1 minute before sending next email, unless it's the last one
      if (i < targetJobs.length - 1) {
        console.log('⏱️ Waiting 1 minute (60 seconds) before sending the next email to prevent spam flagging...');
        await new Promise(resolve => setTimeout(resolve, 5 * 1000));
      }

    } catch (err: any) {
      console.error(`❌ Failed to apply to "${job.company}":`, err.message || err);
      console.log('Proceeding to next job...');
    }
  }

  console.log('\n🎉 Finished processing local applications.');
}

run().catch(err => {
  console.error('❌ Critical script error:', err);
  process.exit(1);
});
