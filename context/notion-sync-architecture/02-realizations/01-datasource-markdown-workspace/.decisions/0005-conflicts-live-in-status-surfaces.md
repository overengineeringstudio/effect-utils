# Surface conflicts through status, not generated page files

Status: accepted

Datasource conflicts, including local-surface conflicts between data files
and `pages/v1/**/*.nmd`, should be canonical in the data file and CLI/status output.
The default workspace should not generate page-adjacent conflict files such as
`pages/foo.conflict.nmd`, because those files expand the user-visible surface and
can be mistaken for editable source artifacts.

Standalone NotionMD may still create body-specific roughdraft/conflict artifacts
when the body merge workflow needs an editable conflict artifact. That is a
body-specific exception, not the generic datasource conflict model.
