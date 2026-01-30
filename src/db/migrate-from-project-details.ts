import { query } from './connection';
import dotenv from 'dotenv';
import pool from './connection';
import { ProjectService } from '../services/ProjectService';
import { ContactService } from '../services/ContactService';
import { ProjectContactService } from '../services/ProjectContactService';

dotenv.config();

export interface ProjectDetailsRow {
  project_id: string;
  detail_result: string | Record<string, unknown>;
  http_status?: number;
  created_at?: string;
  updated_at?: string;
}

/** Parsed detail_result shape (from project_details.detail_result JSON) */
interface DetailAddress {
  fullAddress?: string;
  shortAddress?: string;
  state?: { shortName?: string };
  suburb?: string;
  postcode?: string;
}

interface BuilderDetails {
  id: number;
  name?: string;
  abbrev?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

interface DetailStage {
  id: number;
  name?: string;
  constructionStartDate?: string;
  constructionEndDate?: string;
  builderDetails?: BuilderDetails;
}

interface DetailResult {
  id?: number;
  name?: string;
  address?: DetailAddress;
  stageCategory?: string;
  stageCategoryName?: string;
  minTenderBudget?: number;
  maxTenderBudget?: number;
  awardedTenderBudget?: number;
  tenderQuoteDueAt?: string;
  /** API may provide award date; otherwise we use earliest stage constructionStartDate */
  awardedAt?: string;
  tenderAwardedAt?: string;
  /** Distance (e.g. from search center); may be number or in km */
  distance?: number;
  distanceKm?: number;
  stages?: DetailStage[];
}

function parseDetailResult(raw: string | Record<string, unknown> | null): DetailResult | null {
  if (raw == null) return null;
  if (typeof raw === 'object' && raw !== null && ('name' in raw || 'id' in raw)) return raw as DetailResult;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as DetailResult;
    } catch {
      return null;
    }
  }
  return null;
}

function parseDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch {
    // ignore
  }
  return null;
}

/** Australian state codes for address parsing */
const AU_STATE_CODES = ['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

/**
 * Parse suburb and postcode from Australian address string.
 * e.g. "209 Greens Road, Wyndham Vale VIC 3024" -> suburb: "Wyndham Vale", postcode: "3024"
 * e.g. "Wyndham Vale VIC 3024" -> suburb: "Wyndham Vale", postcode: "3024"
 */
function parseSuburbAndPostcode(
  addressStr: string | null | undefined,
  stateCode?: string | null
): { suburb: string | undefined; postcode: string | undefined } {
  if (!addressStr || !addressStr.trim()) return { suburb: undefined, postcode: undefined };
  const s = addressStr.trim();
  const postcodeMatch = s.match(/\b(\d{4})\s*$/);
  const postcode = postcodeMatch ? postcodeMatch[1] : undefined;
  const state = stateCode ?? AU_STATE_CODES.find((code) => new RegExp(`\\b${code}\\b`, 'i').test(s));
  let suburb: string | undefined;
  if (state) {
    const beforeState = s.split(new RegExp(`\\s+${state}\\b`, 'i'))[0]?.trim();
    if (beforeState) {
      const parts = beforeState.split(',').map((p) => p.trim());
      suburb = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    }
  }
  if (!suburb && postcode) {
    const beforePostcode = s.replace(/\s*\d{4}\s*$/, '').trim();
    const parts = beforePostcode.split(',').map((p) => p.trim());
    suburb = parts.length > 1 ? parts[parts.length - 1].replace(/\s+(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)$/i, '').trim() : beforePostcode.replace(/\s+(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)$/i, '').trim();
  }
  return { suburb: suburb || undefined, postcode };
}

export async function readProjectDetails(limit?: number): Promise<ProjectDetailsRow[]> {
  const tableCheck = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'project_details'
  `);

  if (tableCheck.rows.length === 0) {
    throw new Error('Table project_details not found in the database.');
  }

  const columnsResult = await query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_details'
    ORDER BY ordinal_position
  `);
  const columns = columnsResult.rows.map((r: { column_name: string }) => r.column_name);

  const jsonCol = ['detail_result', 'data', 'payload', 'result'].find((c) => columns.includes(c));
  if (!jsonCol) {
    throw new Error(
      `No JSON column (detail_result/data/payload/result) found in project_details. Columns: ${columns.join(', ')}`
    );
  }

  const httpCol = columns.includes('http_status') ? 'http_status' : columns.find((c) => c.toLowerCase().includes('http')) ?? null;
  const selectCols = ['project_id', jsonCol].concat(httpCol ? [httpCol] : []).concat(['created_at', 'updated_at'].filter((c) => columns.includes(c)));
  const limitClause = limit != null ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : '';
  const sql = `SELECT ${selectCols.join(', ')} FROM project_details WHERE ${jsonCol} IS NOT NULL${limitClause}`;
  const result = await query(sql);

  const rows = result.rows.map((r: Record<string, unknown>) => ({
    project_id: String(r.project_id ?? ''),
    detail_result: r[jsonCol] ?? null,
    ...(httpCol && r[httpCol] != null && { http_status: Number(r[httpCol]) }),
    ...(r.created_at != null && { created_at: String(r.created_at) }),
    ...(r.updated_at != null && { updated_at: String(r.updated_at) }),
  })) as ProjectDetailsRow[];

  return rows;
}

/**
 * Create crm_projects, contacts, project_contacts if they do not exist.
 */
async function ensureCoreTablesExist(): Promise<void> {
  const coreTablesCheck = await query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('crm_projects', 'contacts', 'project_contacts')
  `);
  if (coreTablesCheck.rows.length >= 3) return;

  console.log('Creating crm_projects, contacts, project_contacts...');
  await query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await query(`
    CREATE TABLE IF NOT EXISTS crm_projects (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(500) NOT NULL,
      address VARCHAR(500),
      suburb VARCHAR(255),
      postcode VARCHAR(50),
      state VARCHAR(100),
      category VARCHAR(255),
      awarded_date DATE,
      distance DECIMAL(12, 4),
      budget VARCHAR(255),
      quotes_due_date DATE,
      country VARCHAR(100) DEFAULT 'AU',
      last_contacted_at TIMESTAMP WITH TIME ZONE,
      next_call_eligible_at TIMESTAMP WITH TIME ZONE,
      call_suppressed BOOLEAN DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_crm_projects_project_id ON crm_projects(project_id)');
  await query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      contact_id VARCHAR(255),
      name VARCHAR(500) NOT NULL,
      email VARCHAR(255),
      companyname VARCHAR(500),
      phonenumber VARCHAR(50),
      global_role VARCHAR(100),
      authority_level VARCHAR(100),
      preferred_channel VARCHAR(50),
      do_not_call BOOLEAN DEFAULT false,
      last_ai_contact TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_contact_id_unique ON contacts(contact_id) WHERE contact_id IS NOT NULL');
  await query('CREATE INDEX IF NOT EXISTS idx_contacts_phonenumber ON contacts(phonenumber) WHERE phonenumber IS NOT NULL');
  await query('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email) WHERE email IS NOT NULL');
  await query(`
    CREATE TABLE IF NOT EXISTS project_contacts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id VARCHAR(255) NOT NULL REFERENCES crm_projects(project_id) ON DELETE CASCADE,
      contact_id VARCHAR(255) NOT NULL,
      role_for_project VARCHAR(100),
      role_confidence DECIMAL(3, 2),
      est_start_date DATE,
      est_end_date DATE,
      role_confirmed BOOLEAN DEFAULT false,
      preferred_channel_project VARCHAR(50),
      last_contacted_at TIMESTAMP WITH TIME ZONE,
      suppress_for_project BOOLEAN DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT project_contacts_unique UNIQUE (project_id, contact_id)
    )
  `);
  await query('CREATE INDEX IF NOT EXISTS idx_project_contacts_project_id ON project_contacts(project_id)');
  await query('CREATE INDEX IF NOT EXISTS idx_project_contacts_contact_id ON project_contacts(contact_id)');
  console.log('Core tables ready.');
}

/**
 * Build contacts, projects (crm_projects), and project_contacts from project_details rows.
 * - projects: project_id, name, address, suburb, postcode, state, category, distance, budget, quotes_due_date
 * - contacts: from stages.builderDetails (name, email, phonenumber, companyname, contact_id)
 * - project_contacts: project_id (project's id string), contact_id (contact's id string), est_start_date, est_end_date
 */
export async function buildTablesFromProjectDetails(limit?: number): Promise<{ projects: number; contacts: number; project_contacts: number }> {
  await ensureCoreTablesExist();

  const rows = await readProjectDetails(limit);
  const projectService = new ProjectService();
  const contactService = new ContactService();
  const projectContactService = new ProjectContactService();

  let projectsCount = 0;
  let contactsCount = 0;
  let projectContactsCount = 0;
  const seenContactKeys = new Set<string>();

  for (const row of rows) {
    const detail = parseDetailResult(row.detail_result);
    if (!detail) continue;

    const projectId = String(row.project_id ?? (detail.id ?? ''));

    const address = detail.address;
    const fullAddress = address?.fullAddress ?? address?.shortAddress ?? null;
    const state = address?.state?.shortName ?? null;
    const { suburb: parsedSuburb, postcode: parsedPostcode } = parseSuburbAndPostcode(fullAddress ?? address?.shortAddress, state);
    const suburb = address?.suburb ?? parsedSuburb;
    const postcode = address?.postcode ?? parsedPostcode;

    const budgetStr =
      detail.awardedTenderBudget != null
        ? String(detail.awardedTenderBudget)
        : detail.maxTenderBudget != null
          ? String(detail.maxTenderBudget)
          : detail.minTenderBudget != null
            ? String(detail.minTenderBudget)
            : null;

    const stages = detail.stages ?? [];
    const earliestStart = stages.reduce<string | null>((acc, s) => {
      const d = s.constructionStartDate ? parseDate(s.constructionStartDate) : null;
      if (!d) return acc;
      return acc == null || d < acc ? d : acc;
    }, null);
    const awardedDate =
      detail.awardedAt != null
        ? parseDate(detail.awardedAt)
        : detail.tenderAwardedAt != null
          ? parseDate(detail.tenderAwardedAt)
          : earliestStart;

    const distance =
      detail.distanceKm != null
        ? Number(detail.distanceKm)
        : detail.distance != null
          ? Number(detail.distance)
          : undefined;

    await projectService.upsertProject({
      project_id: projectId,
      name: detail.name ?? 'Unnamed Project',
      address: fullAddress ?? undefined,
      suburb: suburb ?? undefined,
      postcode: postcode ?? undefined,
      state: state ?? undefined,
      category: detail.stageCategory ?? detail.stageCategoryName ?? undefined,
      awarded_date: awardedDate ?? undefined,
      distance,
      budget: budgetStr ?? undefined,
      quotes_due_date: detail.tenderQuoteDueAt ? parseDate(detail.tenderQuoteDueAt) ?? undefined : undefined,
      country: 'AU',
    });
    projectsCount++;

    const seenProjectContactKeys = new Set<string>();

    for (const stage of stages) {
      const builder = stage.builderDetails;
      if (!builder) continue;

      const contactName = builder.contactName ?? builder.name ?? 'Unknown';
      const email = builder.contactEmail ?? undefined;
      const phonenumber = builder.contactPhone ?? undefined;
      const companyname = builder.name ?? undefined;
      const contactId = `builder-${builder.id}`;

      const contact = await contactService.upsertContact({
        contact_id: contactId,
        name: contactName,
        email,
        phonenumber,
        companyname,
      });

      const contactKey = email ? `email:${email}` : phonenumber ? `phonenumber:${phonenumber}` : contactId;
      if (!seenContactKeys.has(contactKey)) {
        seenContactKeys.add(contactKey);
        contactsCount++;
      }

      const linkKey = `${projectId}:${contactId}`;
      if (!seenProjectContactKeys.has(linkKey)) {
        seenProjectContactKeys.add(linkKey);
        await projectContactService.upsertProjectContact(projectId, contactId, {
          est_start_date: stage.constructionStartDate ? parseDate(stage.constructionStartDate) ?? undefined : undefined,
          est_end_date: stage.constructionEndDate ? parseDate(stage.constructionEndDate) ?? undefined : undefined,
        });
        projectContactsCount++;
      }
    }
  }

  return { projects: projectsCount, contacts: contactsCount, project_contacts: projectContactsCount };
}

async function runMigration() {
  try {
    console.log('Building contacts, projects (crm_projects), project_contacts from project_details...');
    const limit = process.env.MIGRATE_LIMIT ? parseInt(process.env.MIGRATE_LIMIT, 10) : undefined;
    const counts = await buildTablesFromProjectDetails(limit);
    console.log('Done.');
    console.log('  projects (crm_projects):', counts.projects);
    console.log('  contacts:', counts.contacts);
    console.log('  project_contacts:', counts.project_contacts);
    return counts;
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { runMigration };
