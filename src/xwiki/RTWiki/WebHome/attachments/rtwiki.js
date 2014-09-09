define([
  'jquery',
  'RTWiki_WebHome_sharejs_textarea',
  'RTWiki_ErrorBox',
  'RTWiki_WebHome_chainpad'
], function($, TextArea, ErrorBox) {

    var ChainPad = window.ChainPad;
    var module = { exports: {} };

    var LOCALSTORAGE_DISALLOW = 'rtwiki-disallow';

    // Number for a message type which will not interfere with chainpad.
    var MESSAGE_TYPE_ISAVED = 5000;

    // how often to check if the document has been saved recently
    var SAVE_DOC_CHECK_CYCLE = 20000;

    // how often to save the document
    var SAVE_DOC_TIME = 60000;

    // How long to wait before determining that the connection is lost.
    var MAX_LAG_BEFORE_DISCONNECT = 30000;

    var warn = function (x) { };
    var debug = function (x) { };
    //debug = function (x) { console.log(x) };
    warn = function (x) { console.log(x) };

    var setStyle = function () {
        $('head').append([
            '<style>',
            '.rtwiki-toolbar {',
            '    width: 100%;',
            '    color: #666;',
            '    font-weight: bold;',
            '    background-color: #f0f0ee;',
            '    border: 0, none;',
            '    height: 24px;',
            '    float: left;',
            '}',
            '.rtwiki-toolbar div {',
            '    padding: 0 10px;',
            '    height: 1.5em;',
            '    background: #f0f0ee;',
            '    line-height: 25px;',
            '    height: 24px;',
            '}',
            '.rtwiki-toolbar-leftside {',
            '    float: left;',
            '}',
            '.rtwiki-toolbar-rightside {',
            '    float: right;',
            '}',
            '.rtwiki-lag {',
            '    float: right;',
            '}',
            '</style>'
         ].join(''));
    };

    var uid = function () {
        return 'rtwiki-uid-' + String(Math.random()).substring(2);
    };

    var updateUserList = function (myUserName, listElement, userList, messages) {
        var meIdx = userList.indexOf(myUserName);
        if (meIdx === -1) {
            listElement.text(messages.disconnected);
            return;
        }
        var userMap = {};
        userMap[messages.myself] = 1;
        userList.splice(meIdx, 1);
        for (var i = 0; i < userList.length; i++) {
            var user;
            if (userList[i].indexOf('xwiki:XWiki.XWikiGuest') === 0) {
                if (userMap.Guests) {
                    user = messages.guests;
                } else {
                    user = messages.guest;
                }
            } else {
                user = userList[i].replace(/^.*-([^-]*)%2d[0-9]*$/, function(all, one) {
                    return decodeURIComponent(one);
                });
            }
            userMap[user] = userMap[user] || 0;
            if (user === messages.guest && userMap[user] > 0) {
                userMap.Guests = userMap[user];
                delete userMap[user];
                user = messages.guests;
            }
            userMap[user]++;
        }
        var userListOut = [];
        for (var name in userMap) {
            if (userMap[name] > 1) {
                userListOut.push(userMap[name] + " " + name);
            } else {
                userListOut.push(name);
            }
        }
        if (userListOut.length > 1) {
            userListOut[userListOut.length-1] =
                messages.and + ' ' + userListOut[userListOut.length-1];
        }
        listElement.text(messages.editingWith + ' ' + userListOut.join(', '));
    };

    var createUserList = function (realtime, myUserName, container, messages) {
        var id = uid();
        $(container).prepend('<div class="rtwiki-userlist" id="'+id+'"></div>');
        var listElement = $('#'+id);
        realtime.onUserListChange(function (userList) {
            updateUserList(myUserName, listElement, userList, messages);
        });
        return listElement;
    };

    var checkLag = function (realtime, lagElement, messages) {
        var lag = realtime.getLag();
        var lagSec = lag.lag/1000;
        var lagMsg = messages.lag + ' ';
        if (lag.waiting && lagSec > 1) {
            lagMsg += "?? " + Math.floor(lagSec);
        } else {
            lagMsg += lagSec;
        }
        lagElement.text(lagMsg);
    };

    var createLagElement = function (socket, realtime, container, messages) {
        var id = uid();
        $(container).append('<div class="rtwiki-lag" id="'+id+'"></div>');
        var lagElement = $('#'+id);
        var intr = setInterval(function () {
            checkLag(realtime, lagElement, messages);
        }, 3000);
        socket.onClose.push(function () { clearTimeout(intr); });
        return lagElement;
    };

    var createRealtimeToolbar = function (container) {
        var id = uid();
        $(container).prepend(
            '<div class="rtwiki-toolbar" id="' + id + '">' +
                '<div class="rtwiki-toolbar-leftside"></div>' +
                '<div class="rtwiki-toolbar-rightside"></div>' +
            '</div>'
        );
        return $('#'+id);
    };

    var now = function () { return (new Date()).getTime(); };

    var getFormToken = function () {
        return $('meta[name="form_token"]').attr('content');
    };

    var getDocumentSection = function (sectionNum, andThen) {
        debug("getting document section...");
        $.ajax({
            url: window.docediturl,
            type: "POST",
            async: true,
            dataType: 'text',
            data: {
                xpage: 'editwiki',
                section: ''+sectionNum
            },
            success: function (jqxhr) {
                var content = $(jqxhr).find('#content');
                if (!content || !content.length) {
                    andThen(new Error("could not find content"));
                } else {
                    andThen(undefined, content.text());
                }
            },
            error: function (jqxhr, err, cause) {
                andThen(new Error(err));
            }
        });
    };

    var getIndexOfDocumentSection = function (documentContent, sectionNum, andThen) {
        getDocumentSection(sectionNum, function (err, content) {
            if (err) {
                andThen(err);
                return;
            }
            // This is screwed up, XWiki generates the section by rendering the XDOM back to
            // XWiki2.0 syntax so it's not possible to find the actual location of a section.
            // See: http://jira.xwiki.org/browse/XWIKI-10430
            var idx = documentContent.indexOf(content);
            if (idx === -1) {
                content = content.split('\n')[0];
                idx = documentContent.indexOf(content);
            }
            if (idx === -1) {
                warn("Could not find section content..");
            } else if (idx !== documentContent.lastIndexOf(content)) {
                warn("Duplicate section content..");
            } else {
                andThen(undefined, idx);
                return;
            }
            andThen(undefined, 0);
        });
    };

    var seekToSection = function (textArea, andThen) {
        var sect = window.location.hash.match(/^#!([\W\w]*&)?section=([0-9]+)/);
        if (!sect || !sect[2]) {
            andThen();
            return;
        }
        var text = $(textArea).text();
        getIndexOfDocumentSection(text, Number(sect[2]), function (err, idx) {
            if (err) { andThen(err); return; }
            if (idx === 0) {
                warn("Attempted to seek to a section which could not be found");
            } else {
                var heightOne = $(textArea)[0].scrollHeight;
                $(textArea).text(text.substring(idx));
                var heightTwo = $(textArea)[0].scrollHeight;
                $(textArea).text(text);
                $(textArea).scrollTop(heightOne - heightTwo);
            }
            andThen();
        })
    };

    var saveDocument = function (textArea, language, andThen) {
        debug("saving document...");
        $.ajax({
            url: window.docsaveurl,
            type: "POST",
            async: true,
            dataType: 'text',
            data: {
                xredirect: '',
                content: $(textArea).val(),
                xeditaction: 'edit',
                comment: 'Auto-Saved by Realtime Session',
                action_saveandcontinue: 'Save & Continue',
                minorEdit: 1,
                ajax: true,
                form_token: getFormToken(),
                language: language
            },
            success: function () {
                andThen();
            },
            error: function (jqxhr, err, cause) {
                warn(err);
                // Don't callback, this way in case of error we will keep trying.
                //andThen();
            }
        });
    };

    /**
     * If we are editing a page which does not exist and creating it from a template
     * then we should not auto-save the document otherwise it will cause RTWIKI-16
     */
    var createPageMode = function () {
        return (window.location.href.indexOf('template=') !== -1);
    };

    var createSaver = function (socket, channel, myUserName, textArea, demoMode, language) {
        var timeOfLastSave = now();
        socket.onMessage.unshift(function (evt) {
            // get the content...
            var chanIdx = evt.data.indexOf(channel);
            var content = evt.data.substring(evt.data.indexOf(':[', chanIdx + channel.length)+1);

            // parse
            var json = JSON.parse(content);

            // not an isaved message
            if (json[0] !== MESSAGE_TYPE_ISAVED) { return; }

            timeOfLastSave = now();
            return false;
        });

        var lastSavedState = '';
        var to;
        var check = function () {
            if (to) { clearTimeout(to); }
            debug("createSaver.check");
            to = setTimeout(check, Math.random() * SAVE_DOC_CHECK_CYCLE);
            if (now() - timeOfLastSave < SAVE_DOC_TIME) { return; }
            var toSave = $(textArea).val();
            if (lastSavedState === toSave) { return; }
            if (demoMode || createPageMode()) { return; }
            saveDocument(textArea, language, function () {
                debug("saved document");
                timeOfLastSave = now();
                lastSavedState = toSave;
                var saved = JSON.stringify([MESSAGE_TYPE_ISAVED, 0]);
                socket.send('1:x' +
                    myUserName.length + ':' + myUserName +
                    channel.length + ':' + channel +
                    saved.length + ':' + saved
                );
            });
        };
        check();
        socket.onClose.push(function () {
            clearTimeout(to);
        });
    };

    var isSocketDisconnected = function (socket, realtime) {
        return socket.readyState === socket.CLOSING ||
            socket.readyState === socket.CLOSED ||
            (realtime.getLag().waiting && realtime.getLag().lag > MAX_LAG_BEFORE_DISCONNECT);
    };

    var setAutosaveHiddenState = function (hidden) {
        var elem = $('#autosaveControl');
        if (hidden) {
            elem.hide();
        } else {
            elem.show();
        }
    };

    var startWebSocket = function (textArea,
                                   toolbarContainer,
                                   websocketUrl,
                                   userName,
                                   channel,
                                   messages,
                                   demoMode,
                                   language)
    {
        debug("Opening websocket");
        localStorage.removeItem(LOCALSTORAGE_DISALLOW);

        var toolbar = createRealtimeToolbar(toolbarContainer);
        var socket = new WebSocket(websocketUrl);
        socket.onClose = [];
        socket.onMessage = [];
        var initState = $(textArea).val();
        var realtime = socket.realtime = ChainPad.create(userName, 'x', channel, initState);
        // for debugging
        window.rtwiki_chainpad = realtime;

        var isErrorState = false;
        var checkSocket = function () {
            if (socket.intentionallyClosing || isErrorState) { return false; }
            if (isSocketDisconnected(socket, realtime)) {
                realtime.abort();
                socket.close();
                ErrorBox.show('disconnected');
                isErrorState = true;
                return true;
            }
            return false;
        };

        socket.onopen = function (evt) {

            createLagElement(socket,
                             realtime,
                             toolbar.find('.rtwiki-toolbar-rightside'),
                             messages);
            createUserList(realtime,
                           userName,
                           toolbar.find('.rtwiki-toolbar-leftside'),
                           messages);

            setAutosaveHiddenState(true);

            createSaver(socket, channel, userName, textArea, demoMode, language);

            socket.onMessage.push(function (evt) {
                debug(evt.data);
                realtime.message(evt.data);
            });
            realtime.onMessage(function (message) { socket.send(message); });

            TextArea.attach($(textArea)[0], realtime, initState);
            debug("Bound websocket");
            realtime.start();
        };
        socket.onclose = function (evt) {
            for (var i = 0; i < socket.onClose.length; i++) {
                if (socket.onClose[i](evt) === false) { return; }
            }
        };
        socket.onmessage = function (evt) {
            for (var i = 0; i < socket.onMessage.length; i++) {
                if (socket.onMessage[i](evt) === false) { return; }
            }
        };
        socket.onerror = function (err) {
            warn(err);
            checkSocket(realtime);
        };

        var to = setInterval(function () {
            checkSocket(realtime);
        }, 500);
        socket.onClose.push(function () {
            clearTimeout(to);
            toolbar.remove();
            setAutosaveHiddenState(false);
        });

        return socket;
    };

    var stopWebSocket = function (socket) {
        debug("Stopping websocket");
        socket.intentionallyClosing = true;
        if (!socket) { return; }
        if (socket.realtime) { socket.realtime.abort(); }
        socket.close();
    };

    var checkSectionEdit = function () {
        var href = window.location.href;
        if (href.indexOf('#') === -1) { href += '#!'; }
        var si = href.indexOf('section=');
        if (si === -1 || si > href.indexOf('#')) { return false; }
        var m = href.match(/([&]*section=[0-9]+)/)[1];
        href = href.replace(m, '');
        if (m[0] === '&') { m = m.substring(1); }
        href = href + '&' + m;
        window.location.href = href;
        return true;
    };

    var editor = function (websocketUrl, userName, messages, channel, demoMode, language) {
        var contentInner = $('#xwikieditcontentinner');
        var textArea = contentInner.find('#content');
        if (!textArea.length) {
            warn("WARNING: Could not find textarea to bind to");
            return;
        }

        if (checkSectionEdit()) { return; }

        setStyle();

        var checked = (localStorage.getItem(LOCALSTORAGE_DISALLOW)) ? "" : 'checked="checked"';
        var allowRealtimeCbId = uid();
        $('#mainEditArea .buttons').append(
            '<div class="rtwiki-allow-outerdiv">' +
                '<label class="rtwiki-allow-label" for="' + allowRealtimeCbId + '">' +
                    '<input type="checkbox" class="rtwiki-allow" id="' + allowRealtimeCbId + '" ' +
                        checked + '" />' +
                    ' ' + messages.allowRealtime +
                '</label>' +
            '</div>'
        );

        var socket;
        var checkboxClick = function (checked) {
            if (checked || demoMode) {
                socket = startWebSocket(textArea,
                                        contentInner,
                                        websocketUrl,
                                        userName,
                                        channel,
                                        messages,
                                        demoMode,
                                        language);
            } else if (socket) {
                localStorage.setItem(LOCALSTORAGE_DISALLOW, 1);
                stopWebSocket(socket);
                socket = undefined;
            }
        };

        seekToSection(textArea, function (err) {
            if (err) { throw err; }
            $('#'+allowRealtimeCbId).click(function () { checkboxClick(this.checked); });
            checkboxClick(checked);
        });
    };

    var main = module.exports.main = function (websocketUrl,
                                               userName,
                                               messages,
                                               channel,
                                               demoMode,
                                               language)
    {

        if (!websocketUrl) {
            throw new Error("No WebSocket URL, please ensure Realtime Backend is installed.");
        }

        // Either we are in edit mode or the document is locked.
        // There is no cross-language way that the UI tells us the document is locked
        // but we can hunt for the force button.
        var forceLink = $('a[href$="&force=1"][href*="/edit/"]');

        var hasActiveRealtimeSession = function () {
            forceLink.text(messages.joinSession);
            forceLink.attr('href', forceLink.attr('href') + '&editor=wiki');
        };

        if (forceLink.length && !localStorage.getItem(LOCALSTORAGE_DISALLOW)) {
            // ok it's locked.
            var socket = new WebSocket(websocketUrl);
            socket.onopen = function (evt) {
                socket.onmessage = function (evt) {
                    debug("Message! " + evt.data);
                    if (evt.data !== ('0:' + channel.length + ':' + channel + '5:[1,0]')) {
                        debug("hasActiveRealtimeSession");
                        socket.close();
                        hasActiveRealtimeSession();
                    }
                };
                socket.send('1:x' + userName.length + ':' + userName +
                    channel.length + ':' + channel + '3:[0]');
                debug("Bound websocket");
            };
        } else if (window.XWiki.editor === 'wiki' || demoMode) {
            editor(websocketUrl, userName, messages, channel, demoMode, language);
        }
    };

    return module.exports;
});
