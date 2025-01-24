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


function ddt#ui#shell#_set_editor(nvim_server) abort
  " Set $EDITOR.
  " NOTE: --remote-tab-wait-silent is not implemented yet in neovim.
  " https://github.com/neovim/neovim/pull/18414
  let editor_command = ''
  if 'g:loaded_guise'->exists()
    " Use guise instead
  elseif 'g:edita_loaded'->exists()
    " Use edita instead
    let editor_command = edita#EDITOR()
  "elseif v:progname ==# 'nvim' && has('nvim-0.7')
  "      \ && nvim_server->expand()->filereadable()
  "  " Use clientserver for neovim
  "  let editor_command =
  "        \ printf('%s --server %s --remote-tab-wait-silent',
  "        \   v:progpath, nvim_server->s:expand())
  elseif v:progname ==# 'nvim' && 'nvr'->executable()
    " Use neovim-remote for neovim
    let editor_command = 'nvr --remote-tab-wait-silent'
  elseif v:progpath->executable() && has('clientserver')
    " Use clientserver for Vim8
    let editor_command =
          \ printf('%s %s --remote-tab-wait-silent',
          \   v:progpath,
          \   (v:servername ==# '' ? '' : ' --servername='.v:servername))
  elseif v:progpath->executable()
    let editor_command = v:progpath
  endif

  if editor_command !=# ''
    let $EDITOR = editor_command
    let $GIT_EDITOR = editor_command
  endif
endfunction

function ddt#ui#shell#_check_prompt() abort
  const current_line = '.'->getline()
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
