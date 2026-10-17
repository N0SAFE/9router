// Add cheap lookup keys for implicit sessions and precomputed session labels.
// The schema auto-sync also performs these additive changes; this migration
// makes the change explicit for databases that use the versioned runner.
import { TABLES, buildCreateTableSql } from "../schema.js";

function hasColumn(db, table, column) {
  return db.all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

const sessionIndexesMigration = {
  version: 2,
  name: "session-indexes",
  up(db) {
    // A v1 DB may predate requestDetails entirely; create it first so the ALTERs
    // and indexes below are safe on every upgrade path.
    db.exec(buildCreateTableSql("requestDetails", TABLES.requestDetails));
    const columns = TABLES.requestDetails.columns;
    for (const column of ["implicitKey", "liveKey", "label"]) {
      if (!hasColumn(db, "requestDetails", column)) {
        const definition = columns[column]
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "")
          .trim();
        db.exec(`ALTER TABLE requestDetails ADD COLUMN ${column} ${definition}`);
      }
    }
    for (const index of TABLES.requestDetails.indexes || []) {
      db.exec(index);
    }
  },
};

export default sessionIndexesMigration;
