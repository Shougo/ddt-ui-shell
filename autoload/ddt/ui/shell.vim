let s:namespace = has('nvim') ? nvim_create_namespace('ddt-ui-shell') : 0

function ddt#ui#shell#_split(params) abort
  if a:params.split ==# ''
    return
  endif

  if a:params.split ==# 'floating' && '*nvim_open_win'->exists()
    call nvim_open_win(bufnr('%'), v:true, #{
          \   relative: 'editor',
          \   row: a:params.winRow->str2nr(),
          \   col: a:params.winCol->str2nr(),
          \   width: a:params.winWidth->str2nr(),
          \   height: a:params.winHeight->str2nr(),
          \   border: a:params.floatingBorder,
          \ })
  elseif a:params.split ==# 'vertical'
    vsplit
    execute 'vertical resize' a:params.winWidth->str2nr()
  elseif a:params.split ==# 'farleft'
    vsplit
    wincmd H
    execute 'vertical resize' a:params.winWidth->str2nr()
  elseif a:params.split ==# 'farright'
    vsplit
    wincmd L
    execute 'vertical resize' a:params.winWidth->str2nr()
  else
    split
    execute 'resize' a:params.winHeight->str2nr()
  endif
endfunction

function ddt#ui#shell#_check_prompt() abort
  if !'b:ddt_ui_shell_prompt_pattern'->exists()
    return
  endif

  const current_line = '.'->getline()
  if current_line ==# ''
    return
  endif

  if '$'->line() ==# '.'->line()
    if !'b:ddt_ui_shell_prompt'->exists() || b:ddt_ui_shell_prompt ==# ''
      return
    endif

    " Check the last prompt line
    if current_line->stridx(b:ddt_ui_shell_prompt) == 0
      return
    endif

    " Overwrite prompt
    call setline('.', b:ddt_ui_shell_prompt)
    startinsert!

    return
  endif

  const check_pattern = '^' .. b:ddt_ui_shell_prompt_pattern
  if current_line !~# check_pattern
    return
  endif

  " Check cursor is outside of prompt.
  const match_end = current_line->matchend(check_pattern)
  if '.'->col() <= match_end
    call cursor(0, match_end + 1)
  endif
endfunction

function ddt#ui#shell#_apply_highlights(highlights) abort
  for hl in a:highlights
    call ddt#ui#shell#_highlight(
          \ hl.highlight,
          \ hl.name,
          \ hl.priority,
          \ hl.bufnr,
          \ hl.row,
          \ hl.col,
          \ hl.length)
  endfor
endfunction

function ddt#ui#shell#_highlight(
      \ highlight, prop_type, priority, bufnr, row, col, length) abort

  if !a:highlight->hlexists()
    call ddt#util#print_error(
          \ printf('highlight "%s" does not exist', a:highlight))
    return
  endif

  if !has('nvim')
    " Add prop_type
    if a:prop_type->prop_type_get(#{ bufnr: a:bufnr })->empty()
      call prop_type_add(a:prop_type, #{
            \   bufnr: a:bufnr,
            \   highlight: a:highlight,
            \   priority: a:priority,
            \   override: v:true,
            \ })
    endif
  endif

  const max_col = getbufoneline(a:bufnr, a:row)->len()
  if a:col > max_col
    return
  endif

  const length =
        \    (a:length ==# 0 || a:col + a:length > max_col)
        \  ? max_col - a:col + 1
        \  : a:length

  if has('nvim')
    call nvim_buf_set_extmark(
          \   a:bufnr,
          \   s:namespace,
          \   a:row - 1,
          \   a:col - 1,
          \   #{
          \     end_col: a:col - 1 + length,
          \     hl_group: a:highlight,
          \   }
          \ )
  else
    call prop_add(a:row, a:col, #{
          \   length: length,
          \   type: a:prop_type,
          \   bufnr: a:bufnr,
          \   id: s:namespace,
          \ })
  endif
endfunction
