/**
 * local-db.js
 * A lightweight, filesystem-based database adapter.
 * Mocks the Supabase client interface for local development without external dependencies.
 * Stores data in a JSON file (../database.json).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '../database.json');

/**
 * Helper class to build and execute queries against the JSON data.
 * Mimics Supabase/PostgREST chainable syntax (select, insert, update, delete, eq, order).
 */
class LocalQueryBuilder {
    constructor(table, db) {
        this.table = table;
        this.db = db;
        this.query = {
            type: 'select', // select, insert, update, delete
            columns: '*',
            filters: [],
            orders: [],
            data: null    // for insert/update
        };
    }

    select(columns = '*') {
        if (this.query.type === 'select') {
            this.query.columns = columns;
        } else {
            // It's an insert/update/delete chaining into select
            this.query.returnData = true;
            this.query.columns = columns;
        }
        return this;
    }

    insert(data) {
        this.query.type = 'insert';
        this.query.data = Array.isArray(data) ? data : [data];
        return this;
    }

    update(data) {
        this.query.type = 'update';
        this.query.data = data;
        return this;
    }

    delete() {
        this.query.type = 'delete';
        return this;
    }

    eq(column, value) {
        this.query.filters.push({ column, operator: 'eq', value });
        return this;
    }

    order(column, { ascending = true } = {}) {
        this.query.orders.push({ column, ascending });
        return this;
    }

    // Chain termination - execute the query
    async then(resolve, reject) {
        try {
            const result = await this.db.execute(this.table, this.query);
            resolve(result);
        } catch (error) {
            if (reject) reject(error);
            else resolve({ data: null, error }); // Supabase style error handling
        }
    }
}

/**
 * Main Database Class.
 * Handles loading/saving JSON and creating query builders.
 */
class LocalDB {
    constructor() {
        this.data = this.loadData();
        console.log("LocalDB initialized.");
    }

    loadData() {
        try {
            if (!fs.existsSync(DB_PATH)) {
                fs.writeFileSync(DB_PATH, JSON.stringify({ news: [], rss_feeds: [], subscribers: [] }, null, 2));
            }
            return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        } catch (e) {
            console.error("Error loading local DB:", e);
            return {};
        }
    }

    saveData() {
        try {
            fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error("Error saving local DB:", e);
        }
    }

    from(table) {
        return new LocalQueryBuilder(table, this);
    }

    async execute(table, query) {
        let records = this.data[table] || [];
        let result = { data: null, error: null };

        // FILTERING
        const applyFilters = (rows) => {
            return rows.filter(row => {
                return query.filters.every(f => {
                    if (f.operator === 'eq') return row[f.column] == f.value;
                    return true;
                });
            });
        };

        try {
            if (query.type === 'select') {
                let rows = applyFilters(records);

                // Ordering
                if (query.orders.length > 0) {
                    rows.sort((a, b) => {
                        for (const o of query.orders) {
                            const valA = a[o.column];
                            const valB = b[o.column];
                            if (valA < valB) return o.ascending ? -1 : 1;
                            if (valA > valB) return o.ascending ? 1 : -1;
                        }
                        return 0;
                    });
                }

                result.data = rows;
            }

            else if (query.type === 'insert') {
                console.log(`[LocalDB] Inserting into ${table}:`, query.data);
                const newRows = query.data.map(row => ({
                    id: crypto.randomUUID(), // Node 19+, or fallback needed if older node
                    created_at: new Date().toISOString(),
                    ...row
                }));

                // Polyfill randomUUID if needed for older Node versions (common issue)
                if (!process.env.TEST_UUID) {
                    newRows.forEach(r => { if (!r.id) r.id = Math.random().toString(36).substring(2) + Date.now().toString(36); })
                }

                this.data[table] = [...records, ...newRows];
                console.log(`[LocalDB] New ${table} count:`, this.data[table].length);
                this.saveData();
                result.data = newRows;
            }

            else if (query.type === 'update') {
                // Need to find which rows to update based on filters
                // LIMITATION: Simple LocalDB usually expects an ID filter for updates
                let updatedCount = 0;

                this.data[table] = records.map(row => {
                    const match = query.filters.every(f => {
                        if (f.operator === 'eq') return row[f.column] == f.value;
                        return true;
                    });

                    if (match) {
                        updatedCount++;
                        return { ...row, ...query.data };
                    }
                    return row;
                });

                if (updatedCount > 0) this.saveData();
                // Return the updated rows (mocking selection)
                result.data = applyFilters(this.data[table]);
            }

            else if (query.type === 'delete') {
                const initialLength = records.length;
                this.data[table] = records.filter(row => {
                    const match = query.filters.every(f => {
                        if (f.operator === 'eq') return row[f.column] == f.value;
                        return true;
                    });
                    return !match; // Keep if it DOES NOT match (delete matches)
                });

                if (this.data[table].length !== initialLength) this.saveData();
                result.data = []; // Delete usually returns null or empty unless select is chained
            }

        } catch (e) {
            result.error = { message: e.message };
        }

        return result;
    }
}

module.exports = LocalDB;
