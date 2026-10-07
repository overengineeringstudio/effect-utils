- The `genie:buck2:test` task discovers the explicit source test directory rather
  than matching copied test files in Buck validation outputs, avoiding stale
  operation-disposition failures and missing-module errors in local runs.
