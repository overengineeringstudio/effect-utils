def repo_key($node):
  if $node.locked?.type == "github" then
    "\($node.locked.owner)/\($node.locked.repo)"
  elif $node.locked?.type == "git" then
    ($node.locked.url // $node.original.url // "") as $url |
    if $url == "" then
      empty
    else
      $url
      | sub("^git\\+ssh://git@github.com/"; "")
      | sub("^ssh://git@github.com/"; "")
      | sub("^git@github.com:"; "")
      | sub("^https://github.com/"; "")
      | sub("\\.git$"; "")
    end
  else
    empty
  end;

[$lf[0].nodes | to_entries[] |
  (repo_key(.value)) as $key |
  select($key != null and $key != "") |
  { key: $key, rev: .value.locked.rev, name: .key }
] as $lock_inputs |
[$ml[0].members | to_entries[] |
  {
    key: (.value.url | split("/") | .[-2:] | join("/")),
    rev: .value.commit,
    name: .key
  }
] as $members |
[$lock_inputs[] as $input |
  [$members[] | select(.key == $input.key)] as $candidates |
  select($candidates | length > 0) |
  [$candidates[] | select(.name == $input.name)] as $named |
  if $named | length == 1 then
    select($input.rev != $named[0].rev) |
    {
      member: $named[0].name,
      input: $input.name,
      expected: $named[0].rev,
      actual: $input.rev,
      reason: "named-member-mismatch"
    }
  elif $named | length > 1 then
    {
      member: $input.name,
      input: $input.name,
      expected: ($named | map(.rev) | unique | join(",")),
      actual: $input.rev,
      reason: "ambiguous-named-member"
    }
  else
    [$candidates[] | select(.rev == $input.rev)] as $matches |
    select($matches | length != 1) |
    {
      member: ($candidates | map(.name) | join(",")),
      input: $input.name,
      expected: ($candidates | map(.rev) | unique | join(",")),
      actual: $input.rev,
      reason: (if $matches | length == 0 then "no-declared-revision" else "ambiguous-revision" end)
    }
  end
]
