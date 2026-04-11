$d  = '<span class="dialogue">'
$dc = '</span>'
$t  = '<span class="thought">'
$tc = '</span>'

function Format-Post($raw) {
  $out = [regex]::Replace($raw,  '"([^"]+)"',                     "$d`"$`1`"$dc")
  $lq  = [char]0x201C; $rq = [char]0x201D
  $out = [regex]::Replace($out,  "$lq([^$rq]+)$rq", "$d$lq`$1${rq}$dc")
  $out = [regex]::Replace($out,  "(?<!\w)'((?:[^']|\w'\w)+)'(?!\w)", "$t'$`1'$tc")
  return $out
}

$tests = @(
  @{ id=1; name="Simple straight quotes"
     input='"Hello there"'
     check={ param($o) $o -eq "$d`"Hello there`"$dc" } }

  @{ id=2; name="Apostrophe inside dialogue"
     input='"I don''t know what happened"'
     check={ param($o) $o -eq "$d`"I don't know what happened`"$dc" } }

  @{ id=3; name="Possessive not treated as thought"
     input="Helena's eyes narrowed slowly"
     check={ param($o) $o -eq "Helena's eyes narrowed slowly" } }

  @{ id=4; name="Curly double quotes"
     input=[char]0x201C + "Hello there" + [char]0x201D
     check={ param($o) $o -eq ($d + [char]0x201C + "Hello there" + [char]0x201D + $dc) } }

  @{ id=5; name="Mixed: dialogue + thought + possessive"
     input="She narrowed her eyes. `"I don't know.`" 'Suspicious.' Helena's instincts screamed."
     check={ param($o)
       $o.Contains("$d`"I don't know.`"$dc") -and
       $o.Contains("${t}'Suspicious.'$tc")   -and
       $o.Contains("Helena's instincts screamed.")
     } }
)

$pass = 0; $fail = 0
Write-Host "-- Parser Test Agent ------------------------------------"
foreach ($test in $tests) {
  $out = Format-Post $test.input
  $ok  = & $test.check $out
  if ($ok) {
    $pass++
    Write-Host "[PASS] Test $($test.id): $($test.name)"
  } else {
    $fail++
    Write-Host "[FAIL] Test $($test.id): $($test.name)"
    Write-Host "       Got: $out"
  }
}
Write-Host "--------------------------------------------------------"
Write-Host "Result: $pass/5 passed  |  $fail/5 failed"
if ($fail -gt 0) { exit 1 }
