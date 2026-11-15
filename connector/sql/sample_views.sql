-- Sample read-only views for the NeuroCapture connector's SQL adapter (PLATFORM_PLAN §3).
-- Hospital IT maps these to its own tables, then grants the connector's database user
-- SELECT on these views only. Columns and names must match, types may differ.
--
-- The CREATE TABLE statements below are a stand-in hospital schema for tests and demos.

CREATE TABLE his_patient (
  mrn TEXT PRIMARY KEY,
  given_name TEXT, family_name TEXT,
  dob DATE, gender TEXT,
  email TEXT, mobile TEXT
);
CREATE TABLE his_diagnosis (mrn TEXT, icd_text TEXT, onset DATE);
CREATE TABLE his_prescription (mrn TEXT, drug TEXT, sig TEXT, started DATE);
CREATE TABLE his_visit (mrn TEXT, visit_date DATE, clinic TEXT, reason TEXT);

CREATE VIEW nc_patients AS
  SELECT mrn, given_name || ' ' || family_name AS full_name, dob AS birth_date,
         CASE gender WHEN 'male' THEN 'M' WHEN 'female' THEN 'F' ELSE 'X' END AS sex,
         email, mobile AS phone
  FROM his_patient;
CREATE VIEW nc_conditions AS SELECT mrn, icd_text AS description, onset AS onset_date FROM his_diagnosis;
CREATE VIEW nc_medications AS
  SELECT mrn, drug AS description, sig AS dosage, started AS start_date FROM his_prescription;
CREATE VIEW nc_encounters AS
  SELECT mrn, visit_date AS encounter_date, clinic AS kind, reason FROM his_visit;

-- v3 (optional): appointments, so reception sees them without typing them again.
CREATE TABLE his_appointment (appt_id TEXT, mrn TEXT, starts TIMESTAMP, doctor TEXT);
CREATE VIEW nc_appointments AS
  SELECT appt_id AS appointment_id, mrn, starts AS start_at, doctor AS practitioner FROM his_appointment;
