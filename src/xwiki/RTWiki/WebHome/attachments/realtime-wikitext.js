define([
    'RTFrontend_errorbox',
    'RTFrontend_toolbar',
    'RTFrontend_realtime_input',
    'RTFrontend_json_ot',
    'RTFrontend_userdata',
    'RTFrontend_tests',
    'json.sortify',
    'RTFrontend_text_patcher',
    'RTFrontend_interface',
    'RTFrontend_saver',
    'RTFrontend_chainpad',
    'RTFrontend_crypto',
    'jquery'
], function (ErrorBox, Toolbar, realtimeInput, JsonOT, UserData, TypingTest, JSONSortify, TextPatcher, Interface, Saver, Chainpad, Crypto) {
    var $ = window.jQuery;

    /* REALTIME_DEBUG exposes a 'version' attribute.
        this must be updated with every release */
    var REALTIME_DEBUG = window.REALTIME_DEBUG = {
        version: '1.19',
        local: {},
        remote: {}
    };

    var canonicalize = function(text) { return text.replace(/\r\n/g, '\n'); };

    window.Toolbar = Toolbar;

    var module = window.REALTIME_MODULE = {};

    var main = module.main = function (editorConfig, docKeys) {

        var WebsocketURL = editorConfig.WebsocketURL;
        var userName = editorConfig.userName;
        var DEMO_MODE = editorConfig.DEMO_MODE;
        var language = editorConfig.language;
        var userAvatar = editorConfig.userAvatarURL;
        var saverConfig = editorConfig.saverConfig || {};
        saverConfig.chainpad = Chainpad;
        saverConfig.editorType = 'rtwiki';
        saverConfig.editorName = 'Wiki';
        saverConfig.isHTML = false;
        saverConfig.mergeContent = true;
        var Messages = saverConfig.messages || {};

        /** Key in the localStore which indicates realtime activity should be disallowed. */
        var LOCALSTORAGE_DISALLOW = editorConfig.LOCALSTORAGE_DISALLOW;

        var $contentInner = $('#xwikieditcontentinner');
        var $textArea = $('#content');

        var channel = docKeys.rtwiki;
        var eventsChannel = docKeys.events;
        var userdataChannel = docKeys.userdata;

        // TOOLBAR style
        var TOOLBAR_CLS = Toolbar.TOOLBAR_CLS;
        var toolbar_style = [
            '<style>',
            '.' + TOOLBAR_CLS + ' {',
            '    width: 100%;',
            '    color: #666;',
            '    font-weight: bold;',
            '    background-color: #f0f0ee;',
            '    border: 0, none;',
            '    height: 24px;',
            '    float: left;',
            '}',
            '.' + TOOLBAR_CLS + ' div {',
            '    padding: 0 10px 0 5px;',
            '    height: 1.5em;',
            '    background: #f0f0ee;',
            '    line-height: 25px;',
            '    height: 24px;',
            '}',
            '</style>'
        ];
        // END TOOLBAR style

        // DISALLOW REALTIME
        var uid = Interface.uid;
        var allowRealtimeCbId = uid();
        Interface.setLocalStorageDisallow(LOCALSTORAGE_DISALLOW);
        var checked = (Interface.realtimeAllowed()? 'checked="checked"' : '');

        Interface.createAllowRealtimeCheckbox(allowRealtimeCbId, checked, Messages.allowRealtime);
        // hide the toggle for autosaving while in realtime because it
        // conflicts with our own autosaving system
        Interface.setAutosaveHiddenState(true);

        var $disallowButton = $('#' + allowRealtimeCbId);
        var disallowClick = function () {
            var checked = $disallowButton[0].checked;
            //console.log("Value of 'allow realtime collaboration' is %s", checked);
            if (checked || DEMO_MODE) {
                Interface.realtimeAllowed(true);

                // TODO : join the RT session without reloading the page?
                window.location.reload();
            } else {
                Interface.realtimeAllowed(false);
                module.abortRealtime();
            }
        };
        $disallowButton.on('change', disallowClick);

        if (!Interface.realtimeAllowed()) {
            console.log("Realtime is disallowed. Quitting");
            return;
        }
        // END DISALLOW REALTIME

        // configure Saver with the merge URL and language settings
        Saver.configure(saverConfig);

        console.log("Creating realtime toggle");

        var whenReady = function () {

            var codemirror = ($('.CodeMirror').length && $('.CodeMirror')[0].CodeMirror) ? true : false;

            var cursorToPos = function(cursor, oldText) {
                var cLine = cursor.line;
                var cCh = cursor.ch;
                var pos = 0;
                var textLines = oldText.split("\n");
                for (var line = 0; line <= cLine; line++) {
                    if(line < cLine) {
                        pos += textLines[line].length+1;
                    }
                    else if(line === cLine) {
                        pos += cCh;
                    }
                }
                return pos;
            };

            var posToCursor = function(position, newText) {
                var cursor = {
                    line: 0,
                    ch: 0
                };
                var textLines = newText.substr(0, position).split("\n");
                cursor.line = textLines.length - 1;
                cursor.ch = textLines[cursor.line].length;
                return cursor;
            };

            // Default wiki behaviour
            var editor = {
                getValue : function () { return $textArea.val(); },
                setValue : function (text) { $textArea.val(text); },
                setReadOnly : function (bool) { $textArea.prop("disabled", bool); },
                getCursor : function () { return $textArea[0]; }, // Should return an object obj with obj.selectionStart and obj.selectionEnd
                setCursor : function (start, end) {
                    $textArea.selectionStart = start;
                    $textArea.selectionEnd = end;
                },
                onChange : function (handler) {
                    $textArea.on('change keyup', handler);
                },
                _ : $textArea
            };

            // Wiki
            var useCodeMirror = function() {
                editor._ = $('.CodeMirror')[0].CodeMirror;
                editor.getValue = function() { return editor._.getValue(); };
                editor.setValue = function (text) {
                    editor._.setValue(text);
                    editor._.save();
                };
                editor.setReadOnly = function (bool) {
                    editor._.setOption('readOnly', bool);
                };
                editor.onChange = function (handler) {
                    editor._.off('change');
                    editor._.on('change', handler);
                };
                editor.getCursor = function () {
                    var doc = canonicalize(editor.getValue());
                    return {
                        selectionStart : cursorToPos(editor._.getCursor('from'), doc),
                        selectionEnd : cursorToPos(editor._.getCursor('to'), doc)
                    }
                };
                editor.setCursor = function (start, end) {
                    var doc = canonicalize(editor.getValue());
                    if(start === end) {
                        editor._.setCursor(posToCursor(start, doc));
                    }
                    else {
                        editor._.setSelection(posToCursor(start, doc), posToCursor(end, doc));
                    }
                };
                editor.onChange(onChangeHandler);
            };

            if (codemirror) { useCodeMirror(); }
            // Change the editor to CodeMirror if it is completely loaded after the initializaion of rtwiki
            $('body').on('DOMNodeInserted', function(e) {
                if ($(e.target).is('.CodeMirror')) {
                    var enableCodeMirror = function() {
                        if ($(e.target)[0] && $(e.target)[0].CodeMirror) {
                            useCodeMirror();
                        } else {
                            setTimeout(enableCodeMirror, 100);
                        }
                    };
                    enableCodeMirror();
                }
            });

            var setEditable = module.setEditable = function (bool) {
                editor.setReadOnly(!bool);
            };

            // don't let the user edit until the pad is ready
            setEditable(false);

            var initializing = true;

            var userData; // List of pretty name of all users (mapped with their server ID)
            var userList; // List of users still connected to the channel (server IDs)
            var myId; // My server ID

            var realtimeOptions = {
                // provide initialstate...
                initialState: editor.getValue() || '',

                // the websocket URL
                websocketURL: WebsocketURL,

                // our username
                userName: userName,

                // the channel we will communicate over
                channel: channel,

                // Crypto object to avoid loading it twice in Cryptpad
                crypto: Crypto,
            };

            var cursorToPos = function(cursor, oldText) {
                var cLine = cursor.line;
                var cCh = cursor.ch;
                var pos = 0;
                var textLines = oldText.split("\n");
                for (var line = 0; line <= cLine; line++) {
                    if(line < cLine) {
                        pos += textLines[line].length+1;
                    }
                    else if(line === cLine) {
                        pos += cCh;
                    }
                }
                return pos;
            };

            var posToCursor = function(position, newText) {
                var cursor = {
                    line: 0,
                    ch: 0
                };
                var textLines = newText.substr(0, position).split("\n");
                cursor.line = textLines.length - 1;
                cursor.ch = textLines[cursor.line].length;
                return cursor;
            };

            var setValueWithCursor = function (newValue) {
                var oldValue = canonicalize(editor.getValue());

                var op = TextPatcher.diff(oldValue, newValue);

                var oldCursor = editor.getCursor();
                var selects = ['selectionStart', 'selectionEnd'].map(function (attr) {
                    return TextPatcher.transformCursor(oldCursor[attr], op);
                });

                editor.setValue(newValue);

                editor.setCursor(selects[0], selects[1]);
            };

            var createSaver = function (info) {
                if(!DEMO_MODE) {
                    // this function displays a message notifying users that there was a merge
                    Saver.lastSaved.mergeMessage = Interface.createMergeMessageElement(toolbar.toolbar
                        .find('.rt-toolbar-rightside'),
                        saverConfig.messages);
                    Saver.setLastSavedContent(editor.getValue());
                    var saverCreateConfig = {
                      formId: "edit", // Id of the wiki page form
                      setTextValue: function(newText, toConvert, callback) {
                          setValueWithCursor(newText);
                          callback();
                          onLocal();
                      },
                      getSaveValue: function() {
                          return Object.toQueryString({ content: editor.getValue() });
                      },
                      getTextValue: function() { return editor.getValue(); },
                      realtime: info.realtime,
                      userList: info.userList,
                      userName: userName,
                      network: info.network,
                      channel: eventsChannel,
                      demoMode: DEMO_MODE
                    }
                    Saver.create(saverCreateConfig);
                }
            };

            var onRemote = realtimeOptions.onRemote = function (info) {
                if (initializing) { return; }

                var newValue = info.realtime.getUserDoc();
                setValueWithCursor(newValue);
            };

            var onInit = realtimeOptions.onInit = function (info) {
                // Create the toolbar
                var $bar = $contentInner;
                userList = info.userList;
                var config = {
                    userData: userData
                };
                toolbar = Toolbar.create($bar, info.myID, info.realtime, info.getLag, info.userList, config, toolbar_style);
            };

            var onReady = realtimeOptions.onReady = function (info) {
                var realtime = module.realtime = info.realtime;
                module.leaveChannel = info.leave;
                module.patchText = TextPatcher.create({
                    realtime: realtime,
                    logging: false,
                });

                var userDoc = module.realtime.getUserDoc();
                myId = info.myId;

                // Update the user list to link the wiki name to the user id
                var userdataConfig = {
                    myId : info.myId,
                    userName : userName,
                    userAvatar : userAvatar,
                    onChange : userList.onChange,
                    crypto : Crypto,
                    transformFunction : JsonOT.validate,
                    editor : 'rtwiki'
                };

                userData = UserData.start(info.network, userdataChannel, userdataConfig);

                editor.setValue(userDoc);

                console.log("Unlocking editor");
                initializing = false;
                setEditable(true);

                onLocal();
                createSaver(info);
            };

            var onAbort = realtimeOptions.onAbort = function (info) {
                console.log("Aborting the session!");
                // TODO inform them that the session was torn down
                toolbar.failed();
                toolbar.toolbar.remove();
                if($disallowButton[0].checked && !module.aborted) {
                    ErrorBox.show('disconnected');
                }
            };

            var onLocal = realtimeOptions.onLocal = function () {
                if (initializing) { return; }

                // serialize your DOM into an object
                var shjson = canonicalize(editor.getValue());

                module.patchText(shjson);

                if (module.realtime.getUserDoc() !== shjson) {
                    console.error("realtime.getUserDoc() !== shjson");
                    module.patchText(shjson, true);
                }
            };

            var rti = module.realtimeInput = realtimeInput.start(realtimeOptions);
            module.abortRealtime = function () {
                module.realtime.abort();
                module.leaveChannel();
                module.aborted = true;
                Saver.stop();
                onAbort();
            };

            var onChangeHandler = function() {
                Saver.destroyDialog();
                Saver.setLocalEditFlag(true);
                onLocal();
            };
            editor.onChange(onChangeHandler);
        };

        whenReady();
    };

    return module;
});
